import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ITEM A — the encoder budget, pinned structurally.
 *
 * Unconstrained capture produced 1.5 MB per second on prod, which no mobile uplink sustains,
 * so the queue fell behind without bound and most of a recording never left the phone.
 *
 * The danger in fixing that is over-constraining: a resolution the device cannot meet, or a
 * recorder option it refuses, would cost the survivor her capture entirely. These assertions
 * exist to make that trade impossible to reintroduce.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const CAPTURE = readFileSync(join(SRC, 'lib', 'capture', 'media-capture.ts'), 'utf8');

describe('A [A] the budget exists', () => {
  it('resolution, frame rate and bitrate are all bounded', () => {
    expect(CAPTURE).toMatch(/width: \{ ideal: \d+ \}/);
    expect(CAPTURE).toMatch(/height: \{ ideal: \d+ \}/);
    expect(CAPTURE).toMatch(/frameRate: \{ ideal: \d+ \}/);
    expect(CAPTURE).toMatch(/const VIDEO_BITS_PER_SECOND = \d[\d_]*;/);
    expect(CAPTURE).toMatch(/const AUDIO_BITS_PER_SECOND = \d[\d_]*;/);
  });

  it('the budget is applied to the recorder, not just declared', () => {
    expect(CAPTURE).toMatch(/videoBitsPerSecond: VIDEO_BITS_PER_SECOND/);
    expect(CAPTURE).toMatch(/audioBitsPerSecond: AUDIO_BITS_PER_SECOND/);
  });

  it('audio-only capture carries no video bitrate', () => {
    const budget = CAPTURE.slice(CAPTURE.indexOf('const budget: MediaRecorderOptions'), CAPTURE.indexOf('const attempts'));
    expect(budget).toMatch(/this\.activeMode === 'audio-video'/);
    const audioBranch = budget.slice(budget.indexOf(': {'));
    expect(audioBranch).not.toMatch(/videoBitsPerSecond/);
  });
});

describe('A [A] the budget can NEVER cost a recording', () => {
  it('resolution and frame rate are ideal-only — an exact value would be a new way to fail', () => {
    // `exact` is legitimate for facingMode (rung 1 of the acquisition ladder) and nowhere else.
    const exacts = [...CAPTURE.matchAll(/exact:/g)].map((m) => CAPTURE.slice(Math.max(0, m.index - 60), m.index));
    for (const before of exacts) {
      expect(before, 'only facingMode may use exact').toMatch(/facingMode/);
    }
    expect(CAPTURE).not.toMatch(/(width|height|frameRate): \{ exact/);
    expect(CAPTURE).not.toMatch(/(width|height|frameRate): \d/); // a bare number is exact
  });

  it('the recorder degrades through its options rather than throwing away the capture', () => {
    const maker = CAPTURE.slice(CAPTURE.indexOf('private makeRecorder'), CAPTURE.indexOf('/** Mount an off-screen'));
    // Four rungs with a mime type, two without; the loop swallows a refusal and relaxes.
    expect(maker).toMatch(/\[\{ mimeType, \.\.\.budget \}, \{ mimeType \}, \{ \.\.\.budget \}, \{\}\]/);
    expect(maker).toMatch(/for \(const options of attempts\)/);
    expect(maker).toMatch(/catch \(error\)/);
  });

  it('the mime type outlives the budget — a container the contact cannot decode is worse', () => {
    const maker = CAPTURE.slice(CAPTURE.indexOf('private makeRecorder'), CAPTURE.indexOf('/** Mount an off-screen'));
    const withBoth = maker.indexOf('{ mimeType, ...budget }');
    const mimeOnly = maker.indexOf('{ mimeType }');
    const budgetOnly = maker.indexOf('{ ...budget }');
    expect(withBoth).toBeLessThan(mimeOnly);
    expect(mimeOnly, 'budget is surrendered before the container').toBeLessThan(budgetOnly);
  });
});

describe('A [A] camera SELECTION is untouched', () => {
  it('the rear lens is still rung 1 and the ladder still has four rungs', () => {
    expect(CAPTURE).toMatch(/\{ facingMode: \{ exact: 'environment' \}, \.\.\.VIDEO_QUALITY \}/);
    expect(CAPTURE).toMatch(/\{ facingMode: \{ ideal: 'environment' \}, \.\.\.VIDEO_QUALITY \}/);
    expect(CAPTURE).toMatch(/\{ \.\.\.VIDEO_QUALITY \},/);
    expect(CAPTURE).toMatch(/getUserMedia\(\{ audio: true, video: false \}\)/);
    // And the front camera is still never requested.
    expect(CAPTURE).not.toMatch(/facingMode[^;]*'user'/);
  });

  it('A adds no gate, no network call, and no UI to the capture path', () => {
    expect(CAPTURE).not.toMatch(/entitlement|activated|paywall|requireSession|getSessionToken/);
    expect(CAPTURE).not.toMatch(/\bapi\(|\bfetch\(/);
  });

  it('the chunk CADENCE is untouched — the problem was size, never timing', () => {
    const config = readFileSync(join(SRC, 'lib', 'capture', 'config.ts'), 'utf8');
    expect(config).toMatch(/export const CHUNK_INTERVAL_MS = 1000;/);
    expect(CAPTURE).toMatch(/recorder\.start\(this\.options\.chunkIntervalMs \?\? 1000\)/);
  });
});
