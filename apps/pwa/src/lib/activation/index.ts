import { LocalClassifier, type ClassificationContext } from '@blackbox/classifier';
import { log } from '@/lib/log';
import { uploadsEnabled } from '@/lib/env';
import {
  appendChunk,
  appendClassification,
  appendLocation,
  createSession,
  getActiveSession,
  getAllActiveSessions,
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
  markQueuedChunkTerminal,
  uploadChunk,
  uploadClassification,
  uploadLocation,
  uploadOrigin,
  uploadTranscript,
  uploadTranscriptionState,
} from '@/lib/upload';
import { markDegradation } from '@/lib/upload/encryption-state';
import { clearTriggerBattery, getTriggerBattery, readBattery, rememberTriggerBattery } from '@/lib/battery';
import type { Classification } from '@blackbox/classifier';
import { acquireWakeLock, isWakeLockHeld, releaseWakeLock } from './wake-lock';
import { fetchEventStatus, startSessionMonitor, stopSessionMonitor } from './session-monitor';
import { startHeartbeat, stopHeartbeat } from './heartbeat';

/** How often the descriptive classifier runs over the session so far. */
const CLASSIFY_INTERVAL_MS = 5000;

/**
 * Brief 55 §C — RETRY ACQUISITION, BECAUSE A DENIAL IS OFTEN A RELEASE THAT HAS NOT LANDED YET.
 *
 * The device test triggered a covert event thirteen seconds after closing an overt one, and the
 * OS refused it a microphone AND a camera. A prior capture that has been told to stop does not
 * always have its tracks reclaimed by the time the next `getUserMedia` is evaluated, and the
 * failure is indistinguishable at the call site from a permission denial: both are a rejected
 * promise.
 *
 * So we ask again. A permission denial answers the same way every time and costs three cheap
 * rejections; a release that was still in flight answers differently the second or third time and
 * we get the recording. Given those two outcomes, not retrying was only ever a way to lose
 * evidence quietly.
 *
 * NOTHING ON THE ALERT PATH WAITS FOR THIS. Dispatch, cascade and the location tracker have all
 * already started by the time capture is attempted; this runs beside them. The delays are short
 * enough to stay inside the first chunk interval and are deliberately not a backoff — this is a
 * race being re-run, not a loaded server being spared.
 */
export const CAPTURE_RETRY_DELAYS_MS = [400, 1200];

async function startCaptureWithRetry(capture: MediaCapture): Promise<boolean> {
  if (await capture.start()) {
    return true;
  }
  for (const delay of CAPTURE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    log.error('capture acquisition failed; retrying', { delay });
    if (await capture.start()) {
      log.error('capture acquired on retry — the first failure was a release race, not a denial');
      return true;
    }
  }
  return false;
}

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
  // RECONCILE EVERY ACTIVE RECORD, not just the newest. A device can hold more than one
  // stale 'active' session, and the alert screen is driven by whether ANY exists — so
  // reconciling only the latest left the others resurrecting the alert on every launch.
  // That, plus a 404 being indistinguishable from "offline", is how a phantom alert
  // survived hard resets.
  //
  // Server truth decides, and only a POSITIVE answer acts: an event the server does not
  // have (or reports closed) closes the local record; a server we cannot REACH changes
  // nothing, because a device recording a real emergency with no signal must keep going.
  // Buffered capture is untouched either way — the upload queue is a separate store and
  // drains on reconnect regardless of session status.
  const stale = await getAllActiveSessions();
  for (const s of stale) {
    if (!uploadsEnabled || !s.eventId || !s.hmacSecret) {
      // Never reached the backend, so there is nothing to reconcile against and nothing
      // to close. It is not a live alert.
      await updateSessionStatus(s.id, 'interrupted', Date.now());
      continue;
    }
    const status = await fetchEventStatus(s.eventId, s.hmacSecret);
    // null = could not ask. Leave it alone.
    if (status === 'closed') {
      await updateSessionStatus(s.id, 'closed', Date.now());
    }
  }

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
      // Brief 50 §D — video is requested for EVERY source now, so audio-only means the platform
      // refused. Declared to the coordinator surface rather than left to be inferred from an
      // absence of video chunks, which is what "no camera was ever wanted" also looks like.
      onVideoUnavailable: (reason) => {
        // No upload needed to make this honest. Video is now requested for EVERY source, so an
        // audio-only capture unambiguously means the platform refused — the coordinator surface
        // states that from the chunk mime types alone, with no client signal to go stale or fail.
        log.error('video unavailable; capture continues audio-only', reason);
      },
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
        uploadChunk(newSessionId, seq, chunk.blob, chunk.mimeType, chunk.isFinal);
      },
      // §A — the recorder stopped without a trailing payload, so the chunk already queued
      // at `sequence` is the terminal one. Promote it in place rather than inventing an
      // empty chunk: the bytes are already correct, only the marker was missing.
      onTerminalFallback: (sequence, reason) => {
        void markQueuedChunkTerminal(newSessionId, sequence, reason);
      },
      onError: (error) => log.error('capture error', error),
    });

    // Final transcript fragments flow into the buffer; the classifier reads the
    // buffer (+ latest interim + tone) on its interval.
    const transcription = new TranscriptionService({
      onFinal: (text, timestamp) => {
        const seq = append(newSessionId, text, timestamp);
        uploadTranscript(newSessionId, seq, text);
        // First words prove it is running. Reported once — the service dedupes transitions.
        uploadTranscriptionState(newSessionId, 'active', 'transcribing');
      },
      // Brief 50 §C — transcription failure REACHES the coordinator and the record instead of
      // presenting as an empty panel. Recording is untouched by any of this: audio is the floor
      // and transcription is never a precondition for it.
      onStatus: ({ state, detail }) => {
        log.error('transcription degraded', { state, detail });
        uploadTranscriptionState(newSessionId, state, detail);
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

    // ═══ BRIEF 55 §C — THE EVIDENCE MICROPHONE ASKS FIRST. ═════════════════════════════════
    //
    // The standing rule: the subsystem whose output is optional never acquires a scarce device
    // resource before the subsystem that is the product. `transcription.start()` opens Web
    // Speech's OWN microphone — a second, entirely independent acquisition — and it used to sit
    // one line ABOVE capture, so on every activation the transcript was first in the queue for
    // the device and the recording was second.
    //
    // ═══ BRIEF 56 — HOW I BROKE TRANSCRIPTION FIXING THAT, AND WHY THIS SHAPE ═══════════════
    //
    // Brief 55 implemented the ordering with `await`: capture was awaited, and transcription
    // moved below it. That is correct about ORDER and wrong about CONTEXT.
    //
    // `SpeechRecognition.start()` requires a live user activation on Chromium. Awaiting
    // getUserMedia — a permission prompt — spends the tap's gesture, so by the time
    // transcription ran the activation was gone and Chromium answered `not-allowed`. This file
    // already carried the warning, about a different call: "before any `await`, so it runs while
    // the tap's user-gesture context is still valid (Chrome drops the gesture after awaits)". I
    // moved a call across an await and did not re-read the sentence twenty lines above it.
    //
    // Measured on production: transcription was `active` on 4 of 6 events before Brief 55 and
    // `unavailable` on 2 of 2 after, on the same device, with capture succeeding both times.
    //
    // THE FIX IS TO STOP USING `await` AS THE ORDERING MECHANISM. `capture.start()` is called
    // first and NOT awaited, so its getUserMedia request is issued ahead of everything; then
    // `transcription.start()` runs on the very next synchronous line, still inside the tap.
    // Capture still asks first — which is all the rule requires — and both acquisitions happen
    // while the gesture is alive. The `await` moves to where the RESULT is actually needed.
    // Brief 59 — one battery read, fired and not awaited. It has a 400ms internal ceiling and
    // nothing waits on it: an instrument that can delay a trigger is not one we are willing to
    // carry on this path.
    void readBattery().then(rememberTriggerBattery);

    const capturePromise = startCaptureWithRetry(capture);

    // STILL INSIDE THE USER GESTURE. Nothing may be awaited between the line above and this one.
    // Guarded, because the failure is invisible in code review and silent at runtime — the only
    // symptom is a transcript that never arrives.
    transcription.start();

    const captureStarted = await capturePromise;
    if (captureStarted) {
      onRecordingStarted(newSessionId);
      // Tone analysis attaches to the EXISTING capture stream — no second mic.
      if (capture.stream) {
        session.tone = new ToneAnalyzer(capture.stream);
        session.tone.start();
      }
    } else {
      // ═══ §A2 — THERE USED TO BE NO `ELSE`. ═══════════════════════════════════════════════
      //
      // That absence is the whole defect. A covert event ran 74 seconds, dispatched, cascaded,
      // took 8 location fixes and closed normally having recorded NOTHING, and no line of code
      // anywhere reacted to `captureStarted === false`. It presented as a working alert.
      //
      // Retention is the existing Brief 36 §D axis, and it already reaches BOTH surfaces the way
      // each is allowed to be reached: plain words in Overt, breathing cadence in Hidden. Nothing
      // additive is rendered in the facade — this drives a value the covert surface was already
      // reading, which is exactly why that axis was built as a cadence rather than a banner.
      markDegradation(newSessionId, 'EVIDENCE_NOT_RETAINED');
      log.error('capture did not start; event is running with NO recording', { sessionId: newSessionId });
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
        // Brief 59 — captured at ACTIVATION and carried here, not read now: this snapshot fires
        // ~12s in, and the question is what the battery was when the alert began.
        battery: getTriggerBattery(),
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
  // A later event must never inherit an earlier event's reading.
  clearTriggerBattery();
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
