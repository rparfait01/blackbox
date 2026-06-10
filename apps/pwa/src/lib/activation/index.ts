import { log } from '@/lib/log';
import {
  appendChunk,
  appendLocation,
  createSession,
  getActiveSession,
  updateSessionStatus,
} from '@/lib/storage';
import type { ActivationSource } from '@/lib/storage/types';
import { MediaCapture } from '@/lib/capture/media-capture';
import { CHUNK_INTERVAL_MS, DEFAULT_CAPTURE_MODE } from '@/lib/capture/config';
import { LocationTracker } from '@/lib/geolocation/location-tracker';
import { acquireWakeLock, isWakeLockHeld, releaseWakeLock } from './wake-lock';

/** A repeat trigger within this window of an existing active session is ignored. */
const DEDUP_WINDOW_MS = 60_000;

interface ActiveSession {
  sessionId: string;
  capture: MediaCapture;
  tracker: LocationTracker;
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
 * Covert by construction: produces no UI output, swallows all errors, and
 * deduplicates repeat triggers within 60s. Returns the session id, or null on
 * failure.
 */
export async function triggerActivation(source: ActivationSource): Promise<string | null> {
  try {
    if (active) {
      log.debug('activation ignored: session already active', active.sessionId);
      return active.sessionId;
    }

    const existing = await getActiveSession();
    if (existing && existing.status === 'active' && Date.now() - existing.startTime < DEDUP_WINDOW_MS) {
      log.debug('activation deduplicated against recent session', existing.id);
      return existing.id;
    }

    const sessionId = crypto.randomUUID();
    const startTime = Date.now();
    const mode = DEFAULT_CAPTURE_MODE;

    await createSession({ id: sessionId, startTime, status: 'active', source, captureMode: mode });

    let sequence = 0;
    const capture = new MediaCapture({
      mode,
      chunkIntervalMs: CHUNK_INTERVAL_MS,
      onChunk: (chunk) => {
        const seq = sequence;
        sequence += 1;
        void appendChunk({
          sessionId,
          sequence: seq,
          timestamp: chunk.timestamp,
          mimeType: chunk.mimeType,
          byteSize: chunk.blob.size,
          blob: chunk.blob,
        });
      },
      onError: (error) => log.error('capture error', error),
    });

    const tracker = new LocationTracker({
      onFix: (fix) => {
        void appendLocation({ sessionId, ...fix });
      },
    });

    // Register before awaiting so isSessionActive()/dedup reflect immediately.
    active = { sessionId, capture, tracker };
    ensureVisibilityReacquire();

    const captureStarted = await capture.start();
    if (captureStarted) {
      onRecordingStarted(sessionId);
    }

    // Location tracking runs regardless of capture permission — a position
    // stream is valuable even if mic/camera was denied.
    tracker.start();

    await acquireWakeLock();

    return sessionId;
  } catch (error) {
    log.error('triggerActivation failed', error);
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
  const { sessionId, capture, tracker } = active;
  active = null;
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
