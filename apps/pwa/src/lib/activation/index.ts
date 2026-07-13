import { LocalClassifier, type ClassificationContext } from '@blackbox/classifier';
import { log } from '@/lib/log';
import { uploadsEnabled } from '@/lib/env';
import {
  appendChunk,
  appendClassification,
  appendLocation,
  closeAllActiveSessions,
  createSession,
  getActiveSession,
  getSession,
  updateSessionStatus,
  type SessionRecord,
} from '@/lib/storage';
import { api } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import type { ActivationSource } from '@/lib/storage/types';
import { MediaCapture } from '@/lib/capture/media-capture';
import { CHUNK_INTERVAL_MS, captureModeForSource } from '@/lib/capture/config';
import { LocationTracker, type GeoFix } from '@/lib/geolocation/location-tracker';
import { TranscriptionService } from '@/lib/transcription';
import { ToneAnalyzer } from '@/lib/tone';
import { append, beginSession, getBuffer } from '@/lib/transcript-buffer';
import {
  registerUploadSession,
  uploadChunk,
  uploadClassification,
  uploadLocation,
  uploadOrigin,
  uploadTranscript,
} from '@/lib/upload';
import type { Classification } from '@blackbox/classifier';
import { acquireWakeLock, isWakeLockHeld, releaseWakeLock } from './wake-lock';
import { fetchEventStatus, startSessionMonitor, stopSessionMonitor } from './session-monitor';
import { startHeartbeat, stopHeartbeat } from './heartbeat';

/** A repeat trigger within this window of an existing active session is ignored. */
const DEDUP_WINDOW_MS = 60_000;

/** How often the descriptive classifier runs over the session so far. */
const CLASSIFY_INTERVAL_MS = 5000;

/** When to freeze the immutable ORIGIN snapshot (Fix Brief 5 D1). */
const ORIGIN_CAPTURE_MS = 12_000;

/**
 * Map an activation source to an ORIGIN trigger type. Current sources are all
 * user-initiated → 'manual'; deadman/tamper arrive with the hardware shell.
 */
function triggerTypeForSource(_source: ActivationSource): 'manual' | 'deadman' | 'tamper' {
  return 'manual';
}

interface ActiveSession {
  sessionId: string;
  startTime: number;
  capture: MediaCapture;
  tracker: LocationTracker;
  transcription: TranscriptionService;
  classifier: LocalClassifier;
  tone: ToneAnalyzer | null;
  classifyTimer: number | null;
  /** The first deterministic classification, frozen into the ORIGIN snapshot. */
  firstClassification: Classification | null;
  /** Latest geolocation fix seen, for the ORIGIN snapshot's initial location. */
  latestFix: GeoFix | null;
  originCaptured: boolean;
}

let active: ActiveSession | null = null;
let visibilityHooked = false;

/** True while a session is recording in this page lifetime. */
export function isSessionActive(): boolean {
  return active !== null;
}

/**
 * Return the client to a genuinely dormant state (Brief 27): stop any in-page
 * recording and mark EVERY local 'active' session closed. The caller has already
 * established the event is closed (the session monitor, or a server dormancy read),
 * so this clears ALL stale active-state — the module flag and every local record —
 * exactly like a fresh login would, with no re-login.
 */
async function resetToDormant(): Promise<void> {
  if (active) {
    await stopActivation();
  }
  await closeAllActiveSessions(Date.now());
}

/**
 * Server-authoritative dormancy reconcile (Brief 27). Asks the SESSION endpoint
 * /v1/me — the same reliable, session-token path check-in uses (and which stays
 * healthy while the event-scoped delivery-status reconcile may not) — whether the
 * account still has an active event. If the server CONFIRMS none, clear all local
 * active-state so the next trigger reads a clean session with no login. Only acts on
 * a confirmed "no active event"; a still-open event (dual-consent not completed) is
 * left alone — that is single-active working, not the bug. Runs on foreground/resume
 * and after a close, so a closure that lands while the app is backgrounded still
 * cleans the slate the moment the app is next seen.
 */
export async function reconcileToServerDormancy(): Promise<void> {
  if (!uploadsEnabled || !getSessionToken()) {
    return;
  }
  const res = await api<{ activeEvent?: boolean }>('/v1/me');
  if (res.ok && res.data?.activeEvent === false) {
    await resetToDormant();
  }
}

/**
 * Reconcile a local 'active' session against the server (Brief 25). Returns true
 * only when the server confirms the event is still active. Conservative on any
 * uncertainty — no backend, no event id yet, or an unreachable server — so a
 * transient failure can never spuriously discard a genuinely-live session; it only
 * lets a trigger through when the server EXPLICITLY reports the event 'closed'.
 */
async function isLocalSessionStillActive(session: SessionRecord): Promise<boolean> {
  if (!uploadsEnabled || !session.eventId || !session.hmacSecret) {
    return true;
  }
  const status = await fetchEventStatus(session.eventId, session.hmacSecret).catch(() => null);
  if (status == null) {
    return true;
  }
  return status !== 'closed';
}

/**
 * Re-hydrate from the SERVER on launch (Fix Brief 6 LT5-1). A refresh must never
 * close an alert and must never strand the user from standing it down:
 *
 *  - A local 'active' session that already has a backend event is RESUMED: the
 *    heartbeat + closure monitor restart so the event stays reachable and the
 *    user can still enter the verified code to stand it down. The ONLY close
 *    door remains POST /standdown with the code; the monitor closes locally only
 *    when the SERVER reports status=closed.
 *  - A local 'active' session that never reached the backend is genuinely stale
 *    (capture died on reload) and is marked 'interrupted'.
 *
 * Capture (mic/camera) is NOT silently re-acquired — the browser requires a user
 * gesture after a reload — but the event stays active and reachable, which is
 * what matters.
 */
export async function resumeActiveSession(): Promise<void> {
  const session = await getActiveSession();
  if (!session) {
    return;
  }
  if (!uploadsEnabled || !session.eventId || !session.hmacSecret) {
    await updateSessionStatus(session.id, 'interrupted', Date.now());
    return;
  }
  // Resume the lifecycle. The monitor reconciles against the server's current
  // status on its first tick: if the alert was already stood down (server
  // 'closed'), it tears down; otherwise it stays active.
  startHeartbeat(session.id);
  startSessionMonitor(session.id, () => {
    stopHeartbeat();
    // Brief 27: closure returns the client fully to dormant (clears every local
    // 'active' record), not just this one session, so no stale state survives.
    void resetToDormant();
  });
}

/**
 * The single entry point that starts recording. In W2 it is called only by the
 * stillpoint-press handler; voice and button sources are accepted so W8 can
 * wire them in without changing this signature.
 *
 * Geolocation note (Fix 1): `watchPosition` is started SYNCHRONOUSLY as the very
 * first statement, before any `await`, so it runs while the press-and-hold's
 * user-gesture context is still valid (Chrome drops the gesture after awaits).
 * Fixes that arrive before the session row exists are buffered in memory and
 * flushed once it does. If the activation is deduplicated, the watch we just
 * started is canceled immediately — no leaked watchers under any code path.
 *
 * Covert by construction: produces no UI output, swallows all errors, and
 * deduplicates repeat triggers within 60s. Returns the session id, or null on
 * failure.
 */
export async function triggerActivation(source: ActivationSource): Promise<string | null> {
  let sessionId: string | null = null;
  const bufferedFixes: GeoFix[] = [];

  let latestFix: GeoFix | null = null;
  const tracker = new LocationTracker({
    onFix: (fix) => {
      latestFix = fix;
      if (active && active.tracker === tracker) {
        active.latestFix = fix;
      }
      if (sessionId === null) {
        // Session row not created yet — buffer until it exists.
        bufferedFixes.push(fix);
      } else {
        void appendLocation({ sessionId, ...fix });
        uploadLocation(sessionId, fix);
      }
    },
  });
  // Synchronous, in-gesture watchPosition call. Must be canceled on every exit
  // path that does not hand the tracker off to a live session.
  tracker.start();

  try {
    if (active) {
      // Brief 26: reconcile the IN-PAGE active session against the server too — not
      // just the local DB record (Brief 25). A close the ~2s monitor hasn't torn
      // down yet must NOT block a re-trigger, or the gesture starts (location watch)
      // then no-ops ("asks for location, doesn't go into alert state"). Dedup only
      // if still active on the server; else tear the stale session down + create
      // fresh. Conservative on any uncertainty so a live recording is never dropped.
      const activeRecord = await getSession(active.sessionId);
      if (!activeRecord || (await isLocalSessionStillActive(activeRecord))) {
        log.debug('activation deduplicated against in-page active session', active.sessionId);
        tracker.stop();
        return active.sessionId;
      }
      log.debug('stale in-page session cleared (server reports closed)', active.sessionId);
      await stopActivation();
      // fall through — create a fresh event
    }

    const existing = await getActiveSession();
    if (
      existing &&
      existing.status === 'active' &&
      Date.now() - existing.startTime < DEDUP_WINDOW_MS
    ) {
      // Brief 25: a local 'active' session can be STALE — the event was closed
      // server-side but the monitor hasn't reconciled it yet (classically right
      // after a close + a mode-switch reload). Deduping against it would silently
      // refuse the NEXT trigger — the "Visible dead after closing a Hidden event"
      // bug. Reconcile against SERVER truth: only dedup when the event is genuinely
      // still active; otherwise clear it locally and fall through to create fresh.
      if (await isLocalSessionStillActive(existing)) {
        log.debug('activation deduplicated against recent active session', existing.id);
        tracker.stop();
        return existing.id;
      }
      log.debug('stale local active session cleared (server reports closed)', existing.id);
      await updateSessionStatus(existing.id, 'closed', Date.now());
      // fall through — create a fresh event
    }

    const newSessionId = crypto.randomUUID();
    const startTime = Date.now();
    // Overt activations capture video; covert stays audio-only (camera off).
    const mode = captureModeForSource(source);

    await createSession({ id: newSessionId, startTime, status: 'active', source, captureMode: mode });

    // Session row now exists: adopt the id and flush any buffered fixes.
    sessionId = newSessionId;
    // Seed the open POST with the freshest fix we already have, so the very
    // first contact notification can carry a position.
    const seedFix = bufferedFixes.length > 0 ? bufferedFixes[bufferedFixes.length - 1] : undefined;
    const initialLocation = seedFix
      ? { lat: seedFix.lat, lon: seedFix.lon, accuracy: seedFix.accuracy }
      : undefined;
    for (const fix of bufferedFixes) {
      void appendLocation({ sessionId, ...fix });
      uploadLocation(sessionId, fix);
    }
    bufferedFixes.length = 0;

    // Initialize the transcript buffer and open the server event. registering
    // the upload session FIRES THE OPEN POST immediately (Fix Brief 1 #3): the
    // contact is notified server-side before any capture starts, so the alert
    // survives the page dying right after activation.
    beginSession(newSessionId);
    registerUploadSession({ sessionId: newSessionId, source, startTime, initialLocation });

    // Begin the heartbeat + lost-beacon lifecycle (server-authoritative): a
    // missed heartbeat escalates ("device went dark") and never cancels.
    startHeartbeat(newSessionId);

    // Start the closure monitor: it polls delivery-status and tears the session
    // down if the contact approves closure. Teardown is exactly stopActivation
    // (covert: no UI change). There is no on-device feedback during the session.
    startSessionMonitor(newSessionId, () => {
      // Brief 27: on server-confirmed closure, clear ALL local active-state so the
      // next trigger reads a clean session (no re-login), not just stop this one.
      void resetToDormant();
    });

    let sequence = 0;
    const capture = new MediaCapture({
      mode,
      chunkIntervalMs: CHUNK_INTERVAL_MS,
      onChunk: (chunk) => {
        const seq = sequence;
        sequence += 1;
        void appendChunk({
          sessionId: newSessionId,
          sequence: seq,
          timestamp: chunk.timestamp,
          mimeType: chunk.mimeType,
          byteSize: chunk.blob.size,
          blob: chunk.blob,
        });
        uploadChunk(newSessionId, seq, chunk.blob, chunk.mimeType);
      },
      onError: (error) => log.error('capture error', error),
    });

    // Final transcript fragments flow into the buffer; the classifier reads the
    // buffer (+ latest interim + tone) on its interval.
    const transcription = new TranscriptionService({
      onFinal: (text, timestamp) => {
        const seq = append(newSessionId, text, timestamp);
        uploadTranscript(newSessionId, seq, text);
      },
      lang: navigator.language,
    });
    const classifier = new LocalClassifier();

    // Hand the live tracker off to the session before the remaining awaits.
    const session: ActiveSession = {
      sessionId: newSessionId,
      startTime,
      capture,
      tracker,
      transcription,
      classifier,
      tone: null,
      classifyTimer: null,
      firstClassification: null,
      latestFix,
      originCaptured: false,
    };
    active = session;
    ensureVisibilityReacquire();

    // Transcription uses its own audio path (Web Speech); start it regardless of
    // capture permission.
    transcription.start();

    const captureStarted = await capture.start();
    if (captureStarted) {
      onRecordingStarted(newSessionId);
      // Tone analysis attaches to the EXISTING capture stream — no second mic.
      if (capture.stream) {
        session.tone = new ToneAnalyzer(capture.stream);
        session.tone.start();
      }
    }

    // Run the descriptive classifier every ~5s for the entire active session,
    // independent of any UI interaction.
    session.classifyTimer = window.setInterval(() => {
      void runClassifyTick(session);
    }, CLASSIFY_INTERVAL_MS);

    // Freeze the ORIGIN snapshot once, ~12s in (covers the first 10–15s of audio
    // + the first deterministic classification + initial voice count). Write-once
    // server-side; it never updates as the event evolves (Fix Brief 5 D1).
    window.setTimeout(() => {
      if (active !== session || session.originCaptured) {
        return;
      }
      session.originCaptured = true;
      const fix = session.latestFix;
      const snap = session.tone?.getSnapshot();
      const fc = session.firstClassification;
      uploadOrigin(session.sessionId, {
        triggerType: triggerTypeForSource(source),
        dtgStart: startTime,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        location: fix ? { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy } : null,
        audioFromSeq: 0,
        audioToSeq: Math.max(0, sequence - 1),
        categories: fc ? fc.matchedCategories.map((m) => m.category) : [],
        threatLevel: fc ? fc.threatLevel : null,
        voiceCount: snap ? snap.speakerCount : null,
      });
    }, ORIGIN_CAPTURE_MS);

    await acquireWakeLock();

    return newSessionId;
  } catch (error) {
    log.error('triggerActivation failed', error);
    // If the tracker was never handed off to `active`, cancel it so no watcher
    // leaks. (Once handed off, the live session owns it.)
    if (active === null || active.tracker !== tracker) {
      tracker.stop();
    }
    return null;
  }
}

/**
 * Stops the active session and marks it closed. Available for cleanup and for
 * W6's closure flow to call; nothing in the W2 UI invokes it (activation is
 * committal — only the contact closes a session).
 */
export async function stopActivation(): Promise<void> {
  if (!active) {
    return;
  }
  const { sessionId, capture, tracker, transcription, tone, classifyTimer } = active;
  active = null;
  stopSessionMonitor();
  stopHeartbeat();
  if (classifyTimer !== null) {
    window.clearInterval(classifyTimer);
  }
  try {
    transcription.stop();
  } catch (error) {
    log.error('transcription stop failed', error);
  }
  try {
    tone?.stop();
  } catch (error) {
    log.error('tone stop failed', error);
  }
  try {
    capture.stop();
  } catch (error) {
    log.error('capture stop failed', error);
  }
  try {
    tracker.stop();
  } catch (error) {
    log.error('tracker stop failed', error);
  }
  await releaseWakeLock();
  await updateSessionStatus(sessionId, 'closed', Date.now());
}

/** Build the current transcript + tone and persist a descriptive Classification. */
async function runClassifyTick(session: ActiveSession): Promise<void> {
  try {
    const finals = getBuffer(session.sessionId).map((fragment) => fragment.text);
    const interim = session.transcription.getLatestInterim();
    const transcript = [...finals, interim]
      .filter((part) => part.length > 0)
      .join(' ')
      .trim();
    const context: ClassificationContext = {
      locale: navigator.language,
      localTime: new Date().toISOString(),
      sessionDurationMs: Date.now() - session.startTime,
      tone: session.tone?.getSnapshot(),
    };
    const classification = await session.classifier.classify(transcript, context);
    if (classification) {
      if (!session.firstClassification) {
        // Freeze the first classification for the ORIGIN snapshot (Fix Brief 5 D1).
        session.firstClassification = classification;
      }
      await appendClassification(session.sessionId, classification);
      uploadClassification(session.sessionId, classification);
    }
  } catch (error) {
    log.error('classify tick failed', error);
  }
}

function onRecordingStarted(sessionId: string): void {
  // Local recording has begun. By design there is NO on-device feedback at any
  // point in an active session — BLACK BOX records and reaches, it does not
  // reassure. This is a development-only log.
  log.debug('recording started', sessionId);
}

function ensureVisibilityReacquire(): void {
  if (visibilityHooked) {
    return;
  }
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active !== null && !isWakeLockHeld()) {
      void acquireWakeLock();
    }
  });
}
