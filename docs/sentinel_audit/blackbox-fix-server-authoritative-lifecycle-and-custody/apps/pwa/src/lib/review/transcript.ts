/**
 * Transcript replay — matching recorded fragments to a playback position.
 *
 * The fragments carry `createdAt` (when the device sent them), not an offset into the
 * recording. So the offset is derived: fragment time minus event-open time. That is an
 * approximation of where in the audio the words fall, and it is labelled as one — the
 * fragments themselves are the record, and the sync is only a reading aid.
 *
 * It is never used to make a claim. If the derived offset is wrong the words are still
 * exactly the words that were transcribed; only their highlight position moves.
 */

export interface RecordedFragment {
  sequence: number;
  text: string;
  isFinal: number;
  createdAt: number;
}

export interface TranscriptLine {
  sequence: number;
  text: string;
  /** Seconds from the start of the recording, derived from createdAt. Never negative. */
  offsetSec: number;
  /** False for an interim fragment the transcriber had not finalised. Shown, but marked. */
  final: boolean;
}

/**
 * Order fragments and give each a playback offset.
 *
 * Ordering is by SEQUENCE, not by time: sequence is the transcriber's own ordering and is the
 * meaning. Two fragments can share a createdAt when they were flushed in one batch, and
 * sorting those by time would scramble her words.
 */
export function buildTranscript(fragments: RecordedFragment[], eventStartMs: number): TranscriptLine[] {
  return [...fragments]
    .sort((a, b) => a.sequence - b.sequence)
    .map((f) => ({
      sequence: f.sequence,
      text: f.text,
      offsetSec: Math.max(0, (f.createdAt - eventStartMs) / 1000),
      final: f.isFinal === 1,
    }));
}

/**
 * The index of the line that should read as "current" at `positionSec`, or -1 before the
 * first line. The current line is the LAST one whose offset has been reached — so the
 * highlight advances with playback and never jumps ahead of what is being heard.
 */
export function activeLineIndex(lines: TranscriptLine[], positionSec: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].offsetSec <= positionSec) index = i;
    else break;
  }
  return index;
}
