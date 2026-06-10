import { LocalClassifier, type ClassificationContext } from '@blackbox/classifier';
import { log } from '@/lib/log';
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
import { CHUNK_INTERVAL_MS, DEFAULT_CAPTURE_MODE } from '@/lib/capture/config';
import { LocationTracker, type GeoFix } from '@/lib/geolocation/location-tracker';
import { TranscriptionService } from '@/lib/transcription';
import { ToneAnalyzer } from '@/lib/tone';
import { append, beginSession, getBuffer } from '@/lib/transcript-buffer';
import {
  registerUploadSession,
  uploadChunk,
  uploadClassification,
  uploadLocation,
  uploadTranscript,
} from '@/lib/upload';
import { acquireWakeLock, isWakeLockHeld, releaseWakeLock } from './wake-lock';

/** A repeat trigger within this window of an existing active session is ignored. */
const DEDUP_WINDOW_MS = 60_000;

/** How often the descriptive classifier runs over the session so far. */
const CLASSIFY_INTERVAL_MS = 5000;

interface ActiveSession {
  sessionId: string;
  startTime: number;
  capture: MediaCapture;
  tracker: LocationTracker;
  transcription: TranscriptionService;
  classifier: LocalClassifier;
  tone: ToneAnalyzer | null;
  classifyTimer: number | null;
}

let active: ActiveSession | null = null;
let visibilityHooked = false;

/** True while a session is recording in this page lifetime. */
export function isSessionActive(): boolean {
  return active !== null;
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

  const tracker = new LocationTracker({
    onFix: (fix) => {
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
      log.debug('activation ignored: session already active', active.sessionId);
      tracker.stop();
      return active.sessionId;
    }

    const existing = await getActiveSession();
    if (
      existing &&
      existing.status === 'active' &&
      Date.now() - existing.startTime < DEDUP_WINDOW_MS
    ) {
      log.debug('activation deduplicated against recent session', existing.id);
      tracker.stop();
      return existing.id;
    }

    const newSessionId = crypto.randomUUID();
    const startTime = Date.now();
    const mode = DEFAULT_CAPTURE_MODE;

    await createSession({ id: newSessionId, startTime, status: 'active', source, captureMode: mode });

    // Session row now exists: adopt the id and flush any buffered fixes.
    sessionId = newSessionId;
    for (const fix of bufferedFixes) {
      void appendLocation({ sessionId, ...fix });
      uploadLocation(sessionId, fix);
    }
    bufferedFixes.length = 0;

    // Initialize the transcript buffer and register the session for uploads.
    beginSession(newSessionId);
    registerUploadSession({ sessionId: newSessionId, source, startTime });

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
      await appendClassification(session.sessionId, classification);
      uploadClassification(session.sessionId, classification);
    }
  } catch (error) {
    log.error('classify tick failed', error);
  }
}

function onRecordingStarted(sessionId: string): void {
  // Local recording has begun. Per the covert design NO haptic fires here — the
  // acknowledgment haptic fires only on network-confirmed delivery (W5). In W2
  // this is a development-only log.
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
