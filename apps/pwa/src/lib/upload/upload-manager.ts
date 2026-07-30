import { signRequest } from '@blackbox/shared';
import type { Classification } from '@blackbox/classifier';

import { log } from '@/lib/log';
import { API_BASE_URL, envelopeEncryptionEnabled, uploadsEnabled } from '@/lib/env';
import { getSessionToken } from '@/lib/auth';
import { getUserHash } from '@/lib/device';
import {
  ENVELOPE_ALG,
  generateDek,
  importPublicKey,
  randomIvPrefix,
  wrapDek,
} from '@/lib/crypto/envelope';
import {
  makeEncryptor,
  sealChunkForSend,
  serializeWrap,
  type CaptureEncryptor,
} from './capture-encryptor';
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
  /** Brief 26 — the per-capture encryptor, prepared off the send path after event open.
   *  `undefined` = not yet attempted; `null` = attempted and NOT available (flag off, no
   *  survivor key, or setup failed) → every chunk uploads plaintext (fail-open). A
   *  ready CaptureEncryptor = chunks encrypt. sendItem never blocks on this. */
  encryptor?: CaptureEncryptor | null;
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
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
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
  // Brief 26 — prepare the capture encryptor OFF the send path. Fire-and-forget: it can
  // never block event-open or the alert notification. Until it resolves (or if it never
  // does), ctx.encryptor is undefined/null and chunks upload plaintext — fail-open.
  void prepareEncryptor(ctx);
  return true;
}

/**
 * Set up the per-capture encryptor: fetch the account's public keys, generate one DEK,
 * wrap it to the survivor (+ org) key, upload the wrapped keys, and only THEN mark the
 * encryptor ready. Every early return leaves ctx.encryptor null → plaintext. This runs
 * entirely off the send path; a failure here never touches a capture's availability.
 */
async function prepareEncryptor(ctx: SessionContext): Promise<void> {
  if (!envelopeEncryptionEnabled || ctx.encryptor !== undefined) {
    return; // flag off, or already attempted — leave plaintext
  }
  ctx.encryptor = null; // mark attempted; stays null (plaintext) unless we fully succeed
  try {
    const eventId = ctx.eventId;
    const secret = ctx.hmacSecret;
    const token = getSessionToken();
    if (!eventId || !secret || !token) {
      return;
    }
    const keysRes = await fetch(`${API_BASE_URL}/v1/me/keys`, { headers: { Authorization: `Bearer ${token}` } });
    if (!keysRes.ok) {
      return;
    }
    const keys = (await keysRes.json()) as { pubkey: string | null; org: { orgPubkey: string; generation: number } | null };
    if (!keys.pubkey) {
      return; // no survivor public key yet → cannot encrypt recoverably → plaintext
    }
    const dek = await generateDek();
    const ivPrefix = randomIvPrefix();
    const wraps: Array<{ recipientType: string; recipientRef: string | null; keyGeneration: number; algId: string; wrappedDek: string }> = [
      {
        recipientType: 'survivor',
        recipientRef: null,
        keyGeneration: 0,
        algId: ENVELOPE_ALG,
        wrappedDek: serializeWrap(await wrapDek(dek, await importPublicKey(keys.pubkey))),
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
      return; // wrapped keys not stored → keep plaintext
    }
    ctx.encryptor = makeEncryptor(dek, eventId, ivPrefix); // ready — chunks now encrypt
  } catch (error) {
    log.error('encryptor prep failed; capture continues plaintext', error);
    // ctx.encryptor stays null → fail-open to plaintext.
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
    path = `/v1/events/${eventId}/chunks/${item.sequence}`;
    const plaintext = new Uint8Array(await (item.blob ?? new Blob()).arrayBuffer());
    // Brief 26 — fail-open by construction: the body STARTS as the plaintext bytes and is
    // only replaced with ciphertext when a ready encryptor seals it within a time bound.
    // Flag off, no key, a throw, or a hang all leave the plaintext body — the chunk lands.
    const sealed = await sealChunkForSend({
      encryptor: ctx.encryptor ?? null,
      plaintext,
      sequence: item.sequence ?? 0,
      isFinal: false,
    });
    body = sealed.body;
    headers['X-Mime-Type'] = item.mimeType ?? 'application/octet-stream';
    headers['Content-Type'] = 'application/octet-stream';
    if (sealed.encrypted && sealed.commitment) {
      headers['X-Plaintext-Commitment'] = sealed.commitment;
      headers['X-Is-Final'] = sealed.isFinal ? '1' : '0';
    }
  } else {
    path = `/v1/events/${eventId}/${item.kind}`;
    body = new TextEncoder().encode(JSON.stringify(item.payload ?? {}));
    headers['Content-Type'] = 'application/json';
  }

  const timestamp = Date.now();
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, ...signed },
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
