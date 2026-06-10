/**
 * Local W2 domain types. These mirror a subset of the data models in
 * BLACKBOX_SOFTWARE_SPEC §3 but stay PWA-local for now — there is no backend
 * until W5, at which point the canonical types move to `packages/shared`.
 */

import type { Classification } from '@blackbox/classifier';

/** `active` while recording; `interrupted` if a reload killed capture; `closed` after closure (W6). */
export type SessionStatus = 'active' | 'interrupted' | 'closed';

/** A Classification persisted against its session. Keyed by [sessionId, timestamp]. */
export type StoredClassification = Classification & { sessionId: string };

/** How a session was triggered. Only `stillpoint-press` is wired in W2; voice/button are W8. */
export type ActivationSource = 'stillpoint-press' | 'voice' | 'button';

export type CaptureMode = 'audio' | 'audio-video';

export interface SessionRecord {
  id: string; // UUID v4
  startTime: number; // epoch ms
  endTime?: number; // epoch ms, set on close/interrupt
  status: SessionStatus;
  source: ActivationSource;
  captureMode: CaptureMode;
}

/** Append-only. Keyed by [sessionId, sequence]; never mutated once written. */
export interface RecordingChunk {
  sessionId: string;
  sequence: number;
  timestamp: number; // epoch ms when the chunk was emitted
  mimeType: string;
  byteSize: number;
  blob: Blob;
}

/** Append-only. Keyed by [sessionId, sequence]; one transcript fragment. */
export interface TranscriptFragment {
  sessionId: string;
  sequence: number;
  text: string;
  timestamp: number; // epoch ms when the fragment was captured
}

/** Append-only. Keyed by [sessionId, timestamp]; never mutated once written. */
export interface LocationPoint {
  sessionId: string;
  timestamp: number; // epoch ms of the fix
  lat: number;
  lon: number;
  accuracy: number; // meters
  altitude: number | null;
  speed: number | null; // m/s
  heading: number | null; // degrees
}
