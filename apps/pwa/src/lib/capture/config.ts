import type { CaptureMode } from '@/lib/storage/types';

/**
 * W2 default capture mode. Audio-only keeps capture simple to test in this
 * phase; audio+front-camera is supported by the recorder and a settings toggle
 * to switch arrives in W9.
 */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'audio';

/** MediaRecorder chunk interval. One chunk per second. */
export const CHUNK_INTERVAL_MS = 1000;
