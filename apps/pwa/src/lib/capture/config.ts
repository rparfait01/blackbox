import type { ActivationSource, CaptureMode } from '@/lib/storage/types';

/**
 * Default capture mode used as a fallback. Audio-only is the safe default; the
 * effective mode is resolved per activation by `captureModeForSource`.
 */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'audio';

/**
 * Capture mode by activation source (Fix Brief 1 #6). Overt (direct-tap)
 * activations record audio + front camera; covert (stillpoint-press) keep the
 * camera OFF so nothing on the user's phone betrays that capture is running.
 * Voice/button default to audio until those overt sources are wired.
 */
export function captureModeForSource(source: ActivationSource): CaptureMode {
  return source === 'direct-tap' ? 'audio-video' : 'audio';
}

/** MediaRecorder chunk interval. One chunk per second. */
export const CHUNK_INTERVAL_MS = 1000;
