import { LocalClassifier, type ClassificationContext } from '@blackbox/classifier';
import { log } from '@/lib/log';
import { uploadsEnabled } from '@/lib/env';
import {
  appendChunk,
  appendClassification,
  appendLocation,
  createSession,
  getActiveSession,
  updateSessionStatus,
} from '@/lib/storage';
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
import { startSessionMonitor, stopSessionMonitor } from './session-monitor';
import { startHeartbeat, stopHeartbeat } from './heartbeat';

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

// The ONE place trigger active-state lives (Brief 30). `active` is the live in-page
// recording session; `starting` guards the sub-second window while one is being
// created. Both are module-scoped, so a reload (which every mode switch is) resets
// them — they can NEVER be stale across a mode switch. The SERVER (resolveSingleActive)
// is the single source of truth for one-event-per-account; these only prevent a
// DUPLICATE in-page capture. There is no local-session dedup and no reconcile: a
// closed event can never block the next trigger, because the client no longer trusts
// a possibly-stale local record — it always asks the server, which decides.
let active: ActiveSession | null = null;
let starting = false;
let visibilityHooked = false;

/** True while a session is recording in this page lifetime. */
export function isSessionActive(): boolean {
  return active !== null;
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
    // Server reported this event closed → tear the resumed lifecycle down. (active
    // is null on a resume; the next trigger asks the server regardless — Brief 30.)
    stopHeartbeat();
    void updateSessionStatus(session.id, 'closed', Date.now());
  });
}

/**
 * triggerAlert — the SINGLE trigger core (Brief 30). Its only job is to emit the
 * signal: create the event, start capture, fire the cascade. It does not know or
 * care whether the app is Visible or Hidden — both display skins wire a double-tap
 * gesture that calls exactly this. All trigger active-state lives here (`active`),
 * in ONE place, never in a mode. Switching modes cannot break the trigger because
 * there is no trigger state in the mode to reconcile.
 *
 * Server-authoritative: it never dedups against a local record and never reconciles
 * — it always creates + POSTs, and the server's resolveSingleActive decides
 * (resume the account's open event, or create fresh). The ONLY client guard is
 * in-page: if a recording is already live/starting in this page, it does not start a
 * second capture. Because that guard is module-scoped, a reload (every mode switch)
 * resets it, so it is never stale.
 *
 * Geolocation note (Fix 1): `watchPosition` is started SYNCHRONOUSLY as the very
 * first statement, before any `await`, so it runs while the tap's user-gesture
 * context is still valid (Chrome drops the gesture after awaits). Covert by
 * construction: produces no UI output and swallows all errors. Returns the session
 * id, or null on failure.
 */
export async function triggerAlert(source: ActivationSource): Promise<string | null> {
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

  // True only for the call that ACQUIRES the create-window lock, so a guard-blocked
  // re-entrant call never releases another call's lock in its finally (Brief 31).
  let acquired = false;
  try {
    // The ONLY guard (Brief 30): a recording is already live or being created in
    // THIS page → don't start a second capture. No local-session dedup, no
    // reconcile — the server (resolveSingleActive) is the authority, so a closed
    // event never blocks the next trigger. Module-scoped, so a reload / mode switch
    // resets it and it is never stale.
    if (active || starting) {
      log.debug('trigger ignored: a recording is already live/starting in this page');
      tracker.stop();
      return active?.sessionId ?? null;
    }
    starting = true;
    acquired = true;

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
      // Server-confirmed closure → tear this in-page session down (clears `active`).
      // The next trigger asks the server regardless, so nothing else needs clearing.
      void stopActivation();
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
    active = session; // `active` now holds the in-page guard; `starting` is released in finally
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
    log.error('triggerAlert failed', error);
    // If the tracker was never handed off to `active`, cancel it so no watcher
    // leaks. (Once handed off, the live session owns it.)
    if (active === null || active.tracker !== tracker) {
      tracker.stop();
    }
    return null;
  } finally {
    // Brief 31: the call that acquired the lock ALWAYS releases it — on completion,
    // error, or abort — so a prior attempt can never wedge `starting` true and
    // dead-arm the trigger until a reload. A guard-blocked re-entrant call
    // (acquired=false) leaves the real owner's lock intact. (`active` remains the
    // live-recording guard, cleared by the session monitor on close.)
    if (acquired) {
      starting = false;
    }
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
