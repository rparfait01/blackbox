import { describe, expect, it } from 'vitest';

import { activeLineIndex, buildTranscript, type RecordedFragment } from './transcript';

function f(sequence: number, text: string, createdAt: number, isFinal = 1): RecordedFragment {
  return { sequence, text, createdAt, isFinal };
}

describe('her words are ordered by sequence, not by clock', () => {
  it('a batch flushed at one instant keeps the transcriber ordering', () => {
    // Both fragments share createdAt because they were sent together. Sorting by time would
    // scramble her sentence; sequence is the meaning.
    const lines = buildTranscript([f(2, 'second', 5_000), f(1, 'first', 5_000)], 0);
    expect(lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('offsets are measured from the event opening', () => {
    const lines = buildTranscript([f(0, 'a', 10_000)], 4_000);
    expect(lines[0].offsetSec).toBe(6);
  });

  it('a fragment stamped before the event opened clamps to zero rather than going negative', () => {
    const lines = buildTranscript([f(0, 'a', 1_000)], 5_000);
    expect(lines[0].offsetSec).toBe(0);
  });

  it('an interim fragment is kept but marked non-final — never silently dropped', () => {
    const lines = buildTranscript([f(0, 'partial words', 1_000, 0)], 0);
    expect(lines[0].final).toBe(false);
    expect(lines[0].text).toBe('partial words');
  });

  it('no fragments yields no lines', () => {
    expect(buildTranscript([], 0)).toEqual([]);
  });
});

describe('the highlight follows playback and never runs ahead of it', () => {
  const lines = buildTranscript([f(0, 'a', 0), f(1, 'b', 10_000), f(2, 'c', 20_000)], 0);

  it('is -1 before the first line is reached', () => {
    expect(activeLineIndex(lines, -1)).toBe(-1);
  });

  it('advances only as each offset is passed', () => {
    expect(activeLineIndex(lines, 0)).toBe(0);
    expect(activeLineIndex(lines, 9.9)).toBe(0);
    expect(activeLineIndex(lines, 10)).toBe(1);
    expect(activeLineIndex(lines, 25)).toBe(2);
  });

  it('stays on the last line past the end', () => {
    expect(activeLineIndex(lines, 10_000)).toBe(2);
  });

  it('is -1 for an empty transcript', () => {
    expect(activeLineIndex([], 5)).toBe(-1);
  });
});
