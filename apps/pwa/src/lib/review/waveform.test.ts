import { describe, expect, it } from 'vitest';

import { reduceToPeaks, waveformPath, type Waveform } from './waveform';

/** A stand-in for AudioBuffer — the reducer only ever touches length/channels/getChannelData,
 *  so the arithmetic is testable without an AudioContext (which jsdom does not provide). */
function buffer(channels: Float32Array[]): AudioBuffer {
  return {
    length: channels[0].length,
    numberOfChannels: channels.length,
    getChannelData: (i: number) => channels[i],
  } as unknown as AudioBuffer;
}

describe('peaks, not averages', () => {
  it('a lone spike in a quiet bucket survives — averaging would erase it', () => {
    const data = new Float32Array(100);
    data[50] = 1; // one loud sample in the second half
    const peaks = reduceToPeaks(buffer([data]), 2);
    expect(peaks[1]).toBe(1);
    expect(peaks[0]).toBe(0);
  });

  it('normalises to the loudest moment so a quiet recording is still legible', () => {
    const data = new Float32Array([0.1, 0.1, 0.05, 0.05]);
    const peaks = reduceToPeaks(buffer([data]), 2);
    expect(Math.max(...peaks)).toBe(1);
  });

  it('takes the loudest across channels', () => {
    const left = new Float32Array([0.2, 0.2]);
    const right = new Float32Array([0.9, 0.1]);
    const peaks = reduceToPeaks(buffer([left, right]), 2);
    expect(peaks[0]).toBe(1); // the 0.9 wins, then normalises to 1
  });

  it('treats negative excursions as loud — amplitude is absolute', () => {
    const peaks = reduceToPeaks(buffer([new Float32Array([-1, 0])]), 1);
    expect(peaks[0]).toBe(1);
  });

  it('silence stays silent rather than dividing by zero', () => {
    const peaks = reduceToPeaks(buffer([new Float32Array(64)]), 8);
    expect([...peaks].every((v) => v === 0)).toBe(true);
  });

  it('produces exactly the requested number of buckets, even for a tiny buffer', () => {
    expect(reduceToPeaks(buffer([new Float32Array(3)]), 16)).toHaveLength(16);
  });
});

describe('the drawn path', () => {
  it('is empty for no peaks, so the caller falls back to a plain bar', () => {
    expect(waveformPath(new Float32Array(0) as Waveform, 100, 20)).toBe('');
  });

  it('is symmetric about the midline and stays within the box', () => {
    const path = waveformPath(new Float32Array([1, 1]) as Waveform, 100, 20);
    const ys = path.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(20);
    // Top and bottom edges are equidistant from the midline.
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(20, 5);
  });

  it('draws silence as a visible line, so a GAP always means missing audio', () => {
    const path = waveformPath(new Float32Array([0, 0]) as Waveform, 100, 20);
    const ys = path.split(' ').map((pair) => Number(pair.split(',')[1]));
    // Not collapsed onto the midline exactly — there is a minimum thickness.
    expect(Math.max(...ys)).toBeGreaterThan(10);
  });
});
