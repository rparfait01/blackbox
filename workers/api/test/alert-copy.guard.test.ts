import { describe, expect, it } from 'vitest';

import { captureLine } from '../src/channels/messages';

/**
 * Brief 33 Fix B §D — THE ALERT NAMES ONLY WHAT IS ACTUALLY CAPTURING.
 *
 * The disclosure itself is deliberate and correct: the recipient is a vetted support contact the
 * survivor chose, not an incidental party, and telling them plainly what is happening is the
 * point of the message. What must never happen is claiming a capture that is not running.
 *
 * A responder who reads "live video" and opens a dashboard with no picture does not conclude the
 * camera failed. They conclude the system lies — at the moment they most need to trust it.
 */
describe('Brief 33 Fix B §D — the capture line is true or absent', () => {
  it('names video ONLY on positive evidence', () => {
    expect(captureLine(true)).toBe('Live video + audio + location active.');
    expect(captureLine(false)).toBe('Live audio + location active.');
  });

  it('unknown claims nothing — undefined is not video', () => {
    // The activation notification fires before any chunk has landed, so `undefined` is the
    // ordinary state at the moment the first alert goes out. It must read as the truthful
    // subset, never as an optimistic guess.
    expect(captureLine(undefined)).toBe('Live audio + location active.');
    expect(captureLine(undefined)).not.toContain('video');
  });

  it('never claims video without audio, or capture without location', () => {
    // Both lines are a superset statement about what a responder can expect to find. A line
    // naming video but not audio would send someone looking for the wrong thing.
    for (const line of [captureLine(true), captureLine(false)]) {
      expect(line).toContain('audio');
      expect(line).toContain('location');
      expect(line.endsWith('active.'), `"${line}" does not read as a statement of what is live`).toBe(true);
    }
  });
});
