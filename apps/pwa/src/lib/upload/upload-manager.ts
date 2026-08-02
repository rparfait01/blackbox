import { signRequest, sha256Hex } from '@blackbox/shared';
import type { Classification } from '@blackbox/classifier';

import { log } from '@/lib/log';
import { API_BASE_URL, envelopeEncryptionEnabled, uploadsEnabled } from '@/lib/env';
import { getSessionToken } from '@/lib/auth';
import { getUserHash } from '@/lib/device';
import { deviceSignatureHeaders } from '@/lib/device-credential';
import {
  ENVELOPE_ALG,
  generateDek,
  importPublicKey,
  randomIvPrefix,
  wrapDek,
} from '@/lib/crypto/envelope';
import {
  makeEncryptor,
  proveEncryptor,
  sealChunkForSend,
  serializeWrap,
} from './capture-encryptor';
import { ensureSurvivorKey } from '@/lib/crypto/key-provisioning';
import {
  degradationForBufferFailure,
  getRecord,
  getState,
  markDegradation,
  markPreparing,
  markReady,
  markRetryable,
  markTerminal,
  transmitDecision,
} from './encryption-state';
import {
  deleteQueuedUpload,
  enqueueUpload,
  getQueuedUploads,
  getSession,
  setSessionBackend,
  updateQueuedUpload,
} from '@/lib/storage';
import type { UploadQueueItem } from '@/lib/storage';
import type { GeoFix } from '@/lib/geolocation/location-tracker';

/**
 * Upload pipeline (W5). Everything to be uploaded goes through a single
 * IndexedDB-backed queue drained by one loop with exponential backoff, so it
 * survives offline windows and page reloads. The Worker event is created lazily
 * (on first drain) so activation never blocks on the network — and so an offline
 * activation still queues data that flushes when connectivity returns.
 *
 * Covert: nothing here ever changes the UI. There is no on-device feedback of
 * any kind during a session — not here and not anywhere — so this pipeline has
 * no user-perceptible effect.
 */

interface SessionContext {
  sessionId: string;
  source: string;
  startTime: number;
  eventId?: string;
  hmacSecret?: string;
  /** A first location fix, seeded into the open POST so the very first
   *  notification can carry a position even before location uploads flush. */
  initialLocation?: { lat: number; lon: number; accuracy?: number };
  /** In-flight open POST, shared so concurrent callers (the eager open + the
   *  queue drain) never create two events for one session — which would fire two
   *  activation notifications (Brief 12 P3 duplicate-LINE). */
  openInFlight?: Promise<boolean>;
  /** Brief 36 §A — encryption state is NOT held here. It lives in encryption-state.ts,
   *  which is its single owner; this context used to carry an `encryptor` field whose
   *  null-ness WAS the state, which is precisely how "not ready yet" became
   *  indistinguishable from "never will be" and produced silent plaintext. */
}

const MAX_BACKOFF_MS = 30_000;
const LOCATION_FLUSH_MS = 5000;

const contexts = new Map<string, SessionContext>();
const locationBatch = new Map<string, Array<Record<string, number>>>();

let timersStarted = false;
let draining = false;
/** The pending drain timer and when it is due, so an earlier request can preempt a later
 *  one (see scheduleDrain — a bulk backoff must never gate the life-safety lane). */
let drainTimer: number | null = null;
let drainDueAt = 0;

/**
 * The one BULK kind. Everything else is a small JSON life-safety message — classifier
 * results, the SITUATION signal, origin, location — and every one of them is worth more to
 * the person on the other end than a megabyte of video that will still be there in a minute.
 *
 * Derived from `kind` in memory: no schema change, no device-DB migration, and items already
 * queued on a phone are classified correctly the moment this ships. A future kind defaults to
 * SIGNAL, which is the safe direction — small and urgent rather than bulky and patient.
 */
function isBulk(item: UploadQueueItem): boolean {
  return item.kind === 'chunk';
}

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
}

function ensureTimers(): void {
  if (timersStarted) {
    return;
  }
  timersStarted = true;
  window.setInterval(flushLocations, LOCATION_FLUSH_MS);
  window.addEventListener('online', () => scheduleDrain(0));
}

/**
 * Schedule the next drain, and let an EARLIER wake-up preempt a later one.
 *
 * The old guard was `if (drainScheduled) return`, which silently dropped every
 * subsequent request. That is a second, quieter starvation bug: once a 1.5 MB video
 * chunk failed and booked a 30-second backoff, a classification enqueued a moment later
 * asked for a 0 ms drain and was ignored — so the coordinator's SITUATION summary went
 * dark for 30 seconds at a time no matter how the lanes were ordered. Priority lanes
 * alone would not have fixed it.
 */
function scheduleDrain(delayMs: number): void {
  const dueAt = Date.now() + Math.max(0, delayMs);
  if (drainTimer !== null) {
    if (dueAt >= drainDueAt) {
      return; // something at least as soon is already pending
    }
    window.clearTimeout(drainTimer);
  }
  drainDueAt = dueAt;
  drainTimer = window.setTimeout(() => {
    drainTimer = null;
    void drainQueue();
  }, Math.max(0, delayMs));
}

/**
 * Open the server event for a live session. This is the client's FIRST network
 * action on activation (Fix Brief 1 #3): it creates the Worker event eagerly —
 * which fires the contact notification server-side — INDEPENDENT of any media
 * capture. Capture/upload follow opportunistically; if the page dies the event
 * stays active. The open is retried with backoff until it succeeds so the alert
 * is durable even across a flaky network at activation.
 */
export function registerUploadSession(session: {
  sessionId: string;
  source: string;
  startTime: number;
  initialLocation?: { lat: number; lon: number; accuracy?: number };
}): void {
  if (!uploadsEnabled) {
    return;
  }
  const ctx: SessionContext = { ...session };
  contexts.set(session.sessionId, ctx);
  ensureTimers();
  // Fire the open POST immediately; do not wait for a queued media item.
  void openEventWithRetry(ctx, 0);
  scheduleDrain(0);
}

/** Create the server event now, retrying with backoff while the session lives. */
async function openEventWithRetry(ctx: SessionContext, attempt: number): Promise<void> {
  if (ctx.eventId) {
    return;
  }
  // If the session context was torn down (session ended) stop retrying.
  if (contexts.get(ctx.sessionId) !== ctx) {
    return;
  }
  try {
    if (await ensureEvent(ctx)) {
      return;
    }
    throw new Error('open failed');
  } catch (error) {
    log.error('event open failed; will retry', error);
    window.setTimeout(() => void openEventWithRetry(ctx, attempt + 1), backoff(attempt + 1));
  }
}

export function uploadChunk(
  sessionId: string,
  sequence: number,
  blob: Blob,
  mimeType: string,
  isFinal = false,
): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'chunk',
    sequence,
    mimeType,
    blob,
    isFinal,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  })
    .then(() => {
      // A successful buffer clears any prior at-risk declaration: storage recovered.
      markDegradation(sessionId, 'NONE');
      scheduleDrain(0);
    })
    .catch((error: unknown) => {
      // Brief 36 §D — THE FAILURE THAT MAKES BUFFERING A LIE.
      //
      // Holding chunks on the device is only a safe answer while the device can actually
      // store them. If IndexedDB is denied, full, or evicted, a capture that is waiting
      // for an encryptor is not "held" — it is GONE, and without this the policy quietly
      // becomes "confidential but lost", which is worse than plaintext.
      //
      // The severity depends on whether anything will ever transmit: in a terminal state
      // the chunk had a route out and lost it (EVIDENCE_NOT_RETAINED); otherwise it is
      // still waiting on one (EVIDENCE_AT_RISK). Both are declared, surfaced and logged;
      // neither touches the alert, which has already gone out.
      log.error('chunk buffering failed — evidence retention degraded', error);
      markDegradation(sessionId, degradationForBufferFailure(getState(sessionId)));
      const ctx = contexts.get(sessionId);
      if (ctx) {
        reportEncryptionState(ctx);
      }
    });
}

/**
 * Brief 38 §A — promote an already-queued chunk to terminal, in place.
 *
 * Used when the recorder stops without flushing a trailing payload: the last chunk is
 * already on the queue with the right bytes, and only its marker is missing. Rewriting the
 * queued item (rather than synthesising an empty final chunk) keeps the evidence exactly as
 * captured and keeps the marker travelling with the item through persistence.
 */
export async function markQueuedChunkTerminal(
  sessionId: string,
  sequence: number,
  reason: string,
): Promise<void> {
  try {
    const pending = await getQueuedUploads();
    const item = pending.find((i) => i.sessionId === sessionId && i.kind === 'chunk' && i.sequence === sequence);
    if (!item) {
      // Already uploaded and dequeued. The capture still ended normally, but the marker
      // cannot be attached retroactively — the server declares the capture ABNORMAL on
      // close, which is the honest answer rather than a marker we cannot authenticate.
      log.error(`terminal chunk ${sequence} already left the queue; capture will close without a marker`);
      return;
    }
    item.isFinal = true;
    item.terminalReason = reason;
    await updateQueuedUpload(item);
    scheduleDrain(0);
  } catch (error) {
    log.error('markQueuedChunkTerminal failed', error);
  }
}

export function uploadLocation(sessionId: string, fix: GeoFix): void {
  if (!uploadsEnabled) {
    return;
  }
  const batch = locationBatch.get(sessionId) ?? [];
  batch.push({
    timestamp: fix.timestamp,
    lat: fix.lat,
    lon: fix.lon,
    ...(fix.accuracy !== null ? { accuracy: fix.accuracy } : {}),
    ...(fix.speed !== null ? { speed: fix.speed } : {}),
  });
  locationBatch.set(sessionId, batch);
}

export function uploadClassification(sessionId: string, classification: Classification): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'classifications',
    payload: { items: [classification] },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

/** Upload the frozen ORIGIN snapshot once (Fix Brief 5 D1). Write-once server-side. */
export function uploadOrigin(sessionId: string, origin: Record<string, unknown>): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'origin',
    payload: origin,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

export function uploadTranscript(sessionId: string, sequence: number, text: string): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'transcripts',
    payload: { fragments: [{ sequence, text, isFinal: true }] },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

/** On launch, resume draining any uploads left queued by a previous session. */
export async function resumeUploads(): Promise<void> {
  if (!uploadsEnabled) {
    return;
  }
  const pending = await getQueuedUploads();
  if (pending.length > 0) {
    ensureTimers();
    scheduleDrain(0);
  }
}

function flushLocations(): void {
  for (const [sessionId, batch] of locationBatch) {
    if (batch.length === 0) {
      continue;
    }
    const points = batch.splice(0, batch.length);
    void enqueueUpload({
      sessionId,
      kind: 'locations',
      payload: { points },
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    }).then(() => scheduleDrain(0));
  }
}

async function resolveContext(sessionId: string): Promise<SessionContext | null> {
  const existing = contexts.get(sessionId);
  if (existing) {
    return existing;
  }
  const row = await getSession(sessionId);
  if (!row) {
    return null;
  }
  const ctx: SessionContext = {
    sessionId,
    source: row.source,
    startTime: row.startTime,
    eventId: row.eventId,
    hmacSecret: row.hmacSecret,
  };
  contexts.set(sessionId, ctx);
  return ctx;
}

async function ensureEvent(ctx: SessionContext): Promise<boolean> {
  if (ctx.eventId && ctx.hmacSecret) {
    return true;
  }
  // Single-flight: if an open POST is already in flight for this session, await
  // it instead of firing a second POST /v1/events (which would create a second
  // event and a duplicate activation notification).
  if (ctx.openInFlight) {
    return ctx.openInFlight;
  }
  const promise = openEvent(ctx);
  ctx.openInFlight = promise;
  try {
    return await promise;
  } finally {
    // Clear the latch only if the open did not succeed, so a later caller can
    // retry; on success ctx.eventId short-circuits at the top.
    if (!ctx.eventId) {
      ctx.openInFlight = undefined;
    }
  }
}

async function openEvent(ctx: SessionContext): Promise<boolean> {
  const userHash = await getUserHash();
  // locale lets the contact dashboard show the right emergency number (W7).
  const locale = typeof navigator !== 'undefined' ? navigator.language : '';
  // Canonical time is UTC ms + the device tz offset (Fix Brief 2 #C6).
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  // Attach the Bearer session token so the Worker ties the event to the user
  // ACCOUNT (events.userId). Without it the event is userHash-only and the
  // guardian-created contact (keyed by userId) can never be resolved — the
  // alert would be created but no notification would have a target.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE_URL}/v1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      userHash,
      source: ctx.source,
      startTime: ctx.startTime,
      locale,
      tzOffsetMinutes,
      location: ctx.initialLocation ?? null,
    }),
  });
  if (response.status !== 201) {
    return false;
  }
  const data = (await response.json()) as { eventId: string; hmacSecret: string };
  ctx.eventId = data.eventId;
  ctx.hmacSecret = data.hmacSecret;
  await setSessionBackend(ctx.sessionId, data.eventId, data.hmacSecret);
  // Brief 36 §C — STILL fire-and-forget, and that is load-bearing. Event creation and the
  // contact cascade have already happened server-side by the time this line runs; nothing
  // below is awaited, so encryption cannot add a millisecond to trigger dispatch. What
  // changed is only what happens to CHUNKS while it is in flight: they are now held on the
  // device instead of racing it onto the wire in the clear.
  void prepareEncryption(ctx);
  return true;
}

/**
 * Establish the per-capture encryptor and drive the state machine (Brief 36 §A).
 *
 * Runs entirely OFF the alert path — never awaited by event open, and it cannot delay the
 * cascade, location, heartbeat or closure. What it governs is chunks, and only chunks.
 *
 * The order is deliberate and every step is a precondition of the next:
 *   1. ensure the account HAS a public key — minting and publishing one if it does not,
 *      because a missing key is a step to take, not a dead end (it was the universal case);
 *   2. generate the per-capture DEK and wrap it to the survivor (+ org);
 *   3. upload the wrapped keys BEFORE anything is encrypted — a chunk encrypted under a
 *      DEK the server holds no wrapped copy of is unrecoverable evidence, which is worse
 *      than plaintext for the person it belongs to;
 *   4. PROVE the encryptor round-trips;
 *   5. only then declare READY.
 *
 * Failures are classified rather than swallowed: anything that could plausibly succeed on
 * a retry is FAILED_RETRYABLE (chunks keep buffering); anything that cannot is
 * FAILED_TERMINAL, which TRANSMITS but declares itself.
 */
/**
 * Brief 36 §E — tell the server what state this capture actually reached, so the report can
 * state the policy that applied and the state reached rather than inferring one later.
 *
 * Fire-and-forget and failure-tolerant: this is a record, not a gate. It runs off the alert
 * path like everything else in this module and can never delay or block a capture.
 */
function reportEncryptionState(ctx: SessionContext): void {
  const eventId = ctx.eventId;
  const secret = ctx.hmacSecret;
  if (!eventId || !secret) {
    return;
  }
  const record = getRecord(ctx.sessionId);
  void (async () => {
    try {
      const path = `/v1/events/${eventId}/encryption-state`;
      const payload = { state: record.state, degradation: record.degradation, reason: record.reason };
      const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
      const ts = Date.now();
      const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp: ts, body: bodyBytes });
      await fetch(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: { ...signed, 'Content-Type': 'application/json' },
        body: bodyBytes as BodyInit,
      });
    } catch (error) {
      log.error('encryption-state report failed (advisory only)', error);
    }
  })();
}

async function prepareEncryption(ctx: SessionContext, attempt = 0): Promise<void> {
  const sessionId = ctx.sessionId;
  if (!envelopeEncryptionEnabled) {
    // The flag is the operator's statement that captures are not to be encrypted at all.
    // Terminal, and DECLARED — the whole point of the amendment is that unencrypted
    // transmission is a stated condition rather than a silent one.
    markTerminal(sessionId, 'envelope_encryption_disabled');
    reportEncryptionState(ctx);
    return;
  }
  if (getState(sessionId) === 'FAILED_TERMINAL') {
    return; // terminal for this capture; never re-attempted
  }
  markPreparing(sessionId);
  const retry = (reason: string): void => {
    markRetryable(sessionId, reason);
    // A retry that escalated to terminal is a verdict worth recording immediately.
    if (getState(sessionId) === 'FAILED_TERMINAL') {
      reportEncryptionState(ctx);
    }
    if (getState(sessionId) === 'FAILED_RETRYABLE') {
      window.setTimeout(() => void prepareEncryption(ctx, attempt + 1), backoff(attempt + 1));
    }
  };
  try {
    const eventId = ctx.eventId;
    const secret = ctx.hmacSecret;
    const token = getSessionToken();
    if (!eventId || !secret) {
      retry('event_not_open');
      return;
    }
    if (!token) {
      // No account session: the capture cannot be wrapped to anyone recoverably. A
      // tokenless (covert) trigger is a real, supported path, so this is terminal for
      // this capture rather than an error — and it declares itself.
      markTerminal(sessionId, 'no_account_session');
      reportEncryptionState(ctx);
      return;
    }
    const keysRes = await fetch(`${API_BASE_URL}/v1/me/keys`, { headers: { Authorization: `Bearer ${token}` } });
    if (!keysRes.ok) {
      retry(`keys_endpoint_${keysRes.status}`);
      return;
    }
    const keys = (await keysRes.json()) as { pubkey: string | null; org: { orgPubkey: string; generation: number } | null };
    let survivorPubkey = keys.pubkey;
    if (!survivorPubkey) {
      // SELF-HEAL. Before this, "no survivor public key" returned early and every chunk
      // went out in the clear — and it was the state of every account in production,
      // because provisioning only ever ran during onboarding.
      survivorPubkey = await ensureSurvivorKey();
      if (!survivorPubkey) {
        retry('no_survivor_key');
        return;
      }
    }
    const dek = await generateDek();
    const ivPrefix = randomIvPrefix();
    const wraps: Array<{ recipientType: string; recipientRef: string | null; keyGeneration: number; algId: string; wrappedDek: string }> = [
      {
        recipientType: 'survivor',
        recipientRef: null,
        keyGeneration: 0,
        algId: ENVELOPE_ALG,
        wrappedDek: serializeWrap(await wrapDek(dek, await importPublicKey(survivorPubkey))),
      },
    ];
    if (keys.org) {
      wraps.push({
        recipientType: 'org',
        recipientRef: null,
        keyGeneration: keys.org.generation,
        algId: ENVELOPE_ALG,
        wrappedDek: serializeWrap(await wrapDek(dek, await importPublicKey(keys.org.orgPubkey))),
      });
    }
    // Upload the wrapped keys BEFORE marking ready — a chunk must never encrypt under a
    // DEK the server has no wrapped copy of (it would be unrecoverable).
    const path = `/v1/events/${eventId}/wrapped-keys`;
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ keys: wraps }));
    const ts = Date.now();
    const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp: ts, body: bodyBytes });
    const up = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: bodyBytes as BodyInit,
    });
    if (!up.ok) {
      // The DEK's wrapped copies are not stored, so anything encrypted under it would be
      // unrecoverable. Retryable — the network is the usual reason.
      retry(`wrapped_keys_${up.status}`);
      return;
    }
    const encryptor = makeEncryptor(dek, eventId, ivPrefix);
    // §A — PROVE it before declaring READY. A non-null object is not proof: a key can
    // exist and still be unusable, and every one of those cases previously surfaced as
    // silent plaintext on the first chunk.
    if (!(await proveEncryptor(encryptor))) {
      retry('encryptor_self_test_failed');
      return;
    }
    markReady(sessionId, encryptor);
    reportEncryptionState(ctx);
  } catch (error) {
    log.error('encryption preparation failed', error);
    retry(`exception:${String(error).slice(0, 80)}`);
  }
}

async function sendItem(item: UploadQueueItem, ctx: SessionContext): Promise<boolean> {
  const eventId = ctx.eventId;
  const secret = ctx.hmacSecret;
  if (!eventId || !secret) {
    return false;
  }

  let path: string;
  let body: Uint8Array;
  const headers: Record<string, string> = {};

  if (item.kind === 'chunk') {
    // THE TRANSMISSION RULE (Brief 36 §B). Read the capture's encryption STATE — never
    // the presence of a key object, which is the inference that produced silent plaintext.
    //
    //   PREPARING / FAILED_RETRYABLE → hold. The chunk stays queued on the device and is
    //     retried; this is the ordinary-timing race the brief closes, where early chunks
    //     of a normal capture used to beat the encryptor onto the network.
    //   READY            → encrypted, or nothing (sealChunkForSend throws rather than
    //     degrading, so a timeout or a crypto failure leaves the bytes on the device).
    //   FAILED_TERMINAL  → transmitted and DECLARED unencrypted. Brief 26's rule that
    //     availability outranks confidentiality is intact: a phone that is taken takes
    //     buffered-only evidence with it. What is gone is doing it quietly — the server
    //     marks the chunk from its OWN observation and an operator alert fires.
    const decision = transmitDecision(item.sessionId);
    if (!decision.transmit) {
      return false; // held on device, deliberately — not a failure to report
    }
    path = `/v1/events/${eventId}/chunks/${item.sequence}`;
    const plaintext = new Uint8Array(await (item.blob ?? new Blob()).arrayBuffer());
    headers['X-Mime-Type'] = item.mimeType ?? 'application/octet-stream';
    headers['Content-Type'] = 'application/octet-stream';
    if (decision.mode === 'ENCRYPTED') {
      // Brief 38 §B — the marker goes into the SEAL, which puts it in the AAD Brief 36
      // already binds (captureId ‖ chunkIndex ‖ finalFlag). That is what authenticates it:
      // a stripped or forged marker no longer matches the AAD the chunk was sealed under,
      // so the chunk fails to decrypt at verification. An unauthenticated terminal marker
      // is worthless, because anyone between the device and the server could add one.
      //
      // This argument used to be hypothetical: every chunk was sent with isFinal:false, so
      // the AAD field existed and was always the same value, and every capture read as
      // truncated by the very mechanism built to prove it was not.
      const sealed = await sealChunkForSend({
        encryptor: decision.encryptor,
        plaintext,
        sequence: item.sequence ?? 0,
        isFinal: item.isFinal === true,
      });
      body = sealed.body;
      headers['X-Plaintext-Commitment'] = sealed.commitment;
      // The header ROUTES; the AAD AUTHENTICATES. The server needs to know which chunk
      // claims to be terminal in order to store and order it, but it holds no key and so
      // cannot verify that claim itself — verification happens at decrypt, where a forged
      // marker breaks the tag. The server's own contribution is structural: it refuses a
      // terminal claim that could not possibly be last (see the chunk route).
      headers['X-Is-Final'] = sealed.isFinal ? '1' : '0';
    } else {
      // DECLARED plaintext. The header is a declaration for the audit trail and the
      // report — it is NOT what the server records. The server derives the stored state
      // from inspecting the bytes itself, so a client that lied (or a client that is
      // simply wrong) cannot make an unencrypted chunk look encrypted.
      body = plaintext;
      // §B — a declared-plaintext chunk has no envelope, so its marker CANNOT be
      // authenticated. It is still sent and still true: the capture did end normally. The
      // export says COMPLETE (UNAUTHENTICATED MARKER) rather than silently downgrading it
      // to ABNORMAL, because calling a normal ending abnormal is its own dishonesty.
      headers['X-Is-Final'] = item.isFinal === true ? '1' : '0';
      headers['X-Encryption-State'] = 'UNENCRYPTED_DECLARED';
      headers['X-Encryption-Reason'] = (decision.reason ?? 'unknown').slice(0, 120);
    }
  } else {
    path = `/v1/events/${eventId}/${item.kind}`;
    body = new TextEncoder().encode(JSON.stringify(item.payload ?? {}));
    headers['Content-Type'] = 'application/json';
  }

  const timestamp = Date.now();
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });

  // Brief 2 Fix A §B — the device proof, attached and NEVER a precondition.
  //
  // `deviceSignatureHeaders` returns `{}` for an unprovisioned device, a browser without
  // WebCrypto, a revoked key, or any failure at all — and there is deliberately no branch here
  // for that case. The upload goes out identically either way. A credential that could stop a
  // chunk reaching the server would be worse than no credential, because the thing it would
  // stop is a survivor's evidence.
  const deviceHeaders = await deviceSignatureHeaders({
    method: 'POST',
    path,
    eventId,
    bodyDigestHex: await sha256Hex(body),
  });

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, ...signed, ...deviceHeaders },
    body: body as BodyInit,
  });
  return response.status >= 200 && response.status < 300;
}

/**
 * Send one queued item. Never throws: on any failure it books the item's own backoff and
 * returns false, so the CALLER decides what that means for its lane.
 *
 * Nothing is ever dropped — an item leaves the queue only on a 2xx. Capture retention is
 * never traded for throughput.
 */
async function trySend(item: UploadQueueItem): Promise<boolean> {
  try {
    const ctx = await resolveContext(item.sessionId);
    if (!ctx) {
      return false; // no session row yet; leave it queued untouched
    }
    const ready = await ensureEvent(ctx);
    if (!ready || !(await sendItem(item, ctx))) {
      throw new Error('upload failed');
    }
    if (item.id !== undefined) {
      await deleteQueuedUpload(item.id);
    }
    return true;
  } catch (error) {
    log.error('upload item failed; will retry', error);
    item.attempts += 1;
    item.nextAttemptAt = Date.now() + backoff(item.attempts);
    try {
      await updateQueuedUpload(item);
    } catch (persistError) {
      log.error('could not persist upload backoff', persistError);
    }
    return false;
  }
}

/**
 * Drain the queue in TWO LANES, life-safety first.
 *
 * The single-lane version let a 1.5 MB video chunk stand in front of a 300-byte
 * classification, so on a real mobile uplink the coordinator's SITUATION summary never
 * populated at all — measured on prod: zero classifications and zero transcripts across
 * events of 67 s and 108 s, while the classifier had produced ~20 of them locally. A
 * coordinator who cannot see the situation cannot act on it.
 *
 *   LANE 1 — SIGNAL: every due item gets an attempt every pass. One item's failure never
 *   blocks the next, and never ends the lane. Order does not matter here; arrival does.
 *
 *   LANE 2 — BULK: strict ascending sequence, and it STOPS at the first failure, because
 *   playback assembly depends on a contiguous sequence. Stopping the LANE never stops the
 *   PASS — that distinction is the whole fix.
 *
 * Single-flight is retained (`draining`): this changes ORDER, not concurrency. No storms.
 */
async function drainQueue(): Promise<void> {
  if (draining) {
    return;
  }
  if (!navigator.onLine) {
    scheduleDrain(5000);
    return;
  }
  draining = true;
  try {
    const items = await getQueuedUploads();
    const now = Date.now();
    // Soonest moment any lane wants to be woken again. Tracked separately so a long bulk
    // backoff can never set the alarm for the signal lane.
    let nextWakeAt = Number.POSITIVE_INFINITY;
    const wakeAt = (at: number): void => {
      nextWakeAt = Math.min(nextWakeAt, at);
    };

    // ---- LANE 1: life-safety signal. Attempt all; a failure is skipped, not fatal. ----
    for (const item of items.filter((i) => !isBulk(i))) {
      if (item.nextAttemptAt > now) {
        wakeAt(item.nextAttemptAt);
        continue;
      }
      if (!(await trySend(item))) {
        wakeAt(item.nextAttemptAt);
      }
    }

    // ---- LANE 2: bulk bytes, in order. Sorted explicitly so the contiguity guarantee is
    // stated in this file rather than inherited from IndexedDB key order. ----
    const bulk = items.filter(isBulk).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const item of bulk) {
      // Brief 38 §C — HOLD THE TERMINAL CHUNK until every earlier chunk of this capture has
      // been acknowledged. The lane is already strictly ascending and stops at the first
      // failure, so this is belt-and-braces — but the claim "this was the last chunk" is
      // only meaningful if it ARRIVES last, and a marker that overtook an unsent predecessor
      // would assert completeness over a hole.
      if (item.isFinal === true && bulk.some((o) => o.sessionId === item.sessionId && (o.sequence ?? 0) < (item.sequence ?? 0))) {
        wakeAt(Date.now() + 1000);
        break;
      }
      if (item.nextAttemptAt > now) {
        wakeAt(item.nextAttemptAt);
        break; // a later chunk must not overtake an earlier one
      }
      if (!(await trySend(item))) {
        wakeAt(item.nextAttemptAt);
        break; // hold the lane so sequence stays contiguous
      }
    }

    const remaining = await getQueuedUploads();
    if (remaining.length > 0) {
      // Never sleep longer than the soonest lane wants. With nothing backed off this is the
      // ordinary 2 s follow-up; with a chunk in 30 s backoff the signal lane still gets its
      // own short cadence rather than inheriting the chunk's.
      const idle = Number.isFinite(nextWakeAt) ? Math.max(0, nextWakeAt - Date.now()) : 2000;
      scheduleDrain(Math.min(2000, idle));
    }
  } finally {
    draining = false;
  }
}
