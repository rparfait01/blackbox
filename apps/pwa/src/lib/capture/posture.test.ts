import { describe, expect, it } from 'vitest';

import { covertVideoWanted } from './posture';

/**
 * Brief 50 — covert video is gated on OBSERVED posture, and the default is audio-only.
 *
 * The distinction that matters: "observed face-up" and "cannot observe" are different facts, and
 * only the first is knowledge. A gate that treats unknown as face-up would be guessing; a gate
 * that treats unknown as face-down would switch the camera on in a survivor's hand.
 */
describe('covert video posture gate', () => {
  it('runs video only when the device is OBSERVED face-down', () => {
    expect(covertVideoWanted('face-down')).toBe(true);
  });

  it('does not run video when observed face-up — the camera-light case', () => {
    expect(covertVideoWanted('face-up')).toBe(false);
  });

  it('defaults to audio-only when posture cannot be observed', () => {
    // iOS without a permission prompt reports nothing. Unknown is not face-down, and the ruling
    // is explicit: if the platform cannot report the state reliably, default to audio-only.
    // Do not guess.
    expect(covertVideoWanted('unknown')).toBe(false);
  });
});
