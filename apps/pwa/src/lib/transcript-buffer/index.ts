import { appendTranscriptFragment, getTranscriptFragments } from '@/lib/storage';
import type { TranscriptFragment } from '@/lib/storage';

export interface BufferedFragment {
  sequence: number;
  text: string;
  timestamp: number;
}

/**
 * In-memory rolling transcript buffer, one list per active session.
 *
 * `append` is write-through: each fragment is added to the in-memory list AND
 * persisted to the `transcripts` IndexedDB store immediately. The in-memory
 * copy gives the classifier (W4) fast access during a live session; the
 * write-through means a reload or crash mid-session does not lose the transcript
 * (it is already persisted, not only flushed at session end).
 */
const buffers = new Map<string, BufferedFragment[]>();

/** Initialize an empty in-memory buffer for a session (idempotent). */
export function beginSession(sessionId: string): void {
  if (!buffers.has(sessionId)) {
    buffers.set(sessionId, []);
  }
}

/** Append a transcript fragment to the in-memory buffer and persist it; returns its sequence. */
export function append(sessionId: string, fragment: string, timestamp: number): number {
  let list = buffers.get(sessionId);
  if (!list) {
    list = [];
    buffers.set(sessionId, list);
  }
  const sequence = list.length;
  list.push({ sequence, text: fragment, timestamp });
  void appendTranscriptFragment({ sessionId, sequence, text: fragment, timestamp });
  return sequence;
}

/** Current in-memory buffer contents for a session. */
export function getBuffer(sessionId: string): BufferedFragment[] {
  return buffers.get(sessionId) ?? [];
}

/** Persisted transcript for a session, read back from IndexedDB. */
export function getSessionTranscript(sessionId: string): Promise<TranscriptFragment[]> {
  return getTranscriptFragments(sessionId);
}

/** Clear the in-memory buffer for a session. */
export function clear(sessionId: string): void {
  buffers.delete(sessionId);
}
