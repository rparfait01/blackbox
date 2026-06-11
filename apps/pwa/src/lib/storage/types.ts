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

/** How a session was triggered. `stillpoint-press` (covert) and `direct-tap` (direct mode) are wired; voice/button are later. */
export type ActivationSource = 'stillpoint-press' | 'direct-tap' | 'voice' | 'button';

export type CaptureMode = 'audio' | 'audio-video';

export interface SessionRecord {
  id: string; // UUID v4
  startTime: number; // epoch ms
  endTime?: number; // epoch ms, set on close/interrupt
  status: SessionStatus;
  source: ActivationSource;
  captureMode: CaptureMode;
  // Backend linkage (W5), set once the event is created on the Worker.
  eventId?: string;
  hmacSecret?: string;
}

export type UploadKind = 'chunk' | 'locations' | 'classifications' | 'transcripts' | 'close';

/** A pending upload, persisted so uploads survive offline windows and reloads. */
export interface UploadQueueItem {
  id?: number; // auto-increment key
  sessionId: string;
  kind: UploadKind;
  sequence?: number; // chunk sequence
  mimeType?: string; // chunk mime
  blob?: Blob; // chunk bytes
  payload?: unknown; // JSON body for non-chunk kinds
  attempts: number;
  nextAttemptAt: number; // epoch ms; do not retry before this
  createdAt: number;
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
