import { describe, expect, it } from 'vitest';

import { code } from '../../../test-utils/guard-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)));
const ACTIVATION = code(join(SRC, 'lib', 'activation', 'index.ts')) as string;
const CAPTURE = code(join(SRC, 'lib', 'capture', 'media-capture.ts')) as string;
const SPEECH = code(join(SRC, 'lib', 'transcription', 'speech-recognition.ts')) as string;

/**
 * BRIEF 55 §C — THE EVIDENCE MICROPHONE IS ACQUIRED BEFORE ANY OTHER SUBSYSTEM'S.
 *
 * ═══ THE STANDING RULE THIS ENFORCES ═════════════════════════════════════════════════════════
 *
 * "The subsystem whose output is optional never acquires a scarce device resource before the
 * subsystem that is the product."
 *
 * Web Speech opens its OWN microphone — a second, wholly independent acquisition — and on iOS
 * Safari holding it is enough to make a subsequent getUserMedia fail. `transcription.start()` sat
 * one line ABOVE `capture.start()`, so on every single activation the transcript was first in the
 * queue for the device and the recording was second.
 *
 * A transcript with no recording behind it is a text file. A recording with no transcript is
 * still evidence.
 *
 * ═══ WHY ORDER IS GUARDED AND NOT JUST WRITTEN ═══════════════════════════════════════════════
 *
 * Statement order carries no syntactic weight — nothing about the code looks wrong with the two
 * lines swapped, no type changes, no test fails. It is exactly the kind of property that is
 * correct today and quietly reversed by a future edit that moves a block for readability.
 */
describe('§C — capture acquires the microphone first', () => {
  it('both call sites exist — this guard names its subjects', () => {
    // Fails distinctly if either is renamed, so "no violation found" can never be produced by
    // having found nothing at all.
    expect(ACTIVATION, 'capture start call site not found').toMatch(/startCaptureWithRetry\(capture\)/);
    expect(ACTIVATION, 'transcription start call site not found').toMatch(/transcription\.start\(\);/);
  });

  it('capture ASKS before transcription does', () => {
    const captureAt = ACTIVATION.indexOf('startCaptureWithRetry(capture)');
    const speechAt = ACTIVATION.indexOf('transcription.start();');
    expect(captureAt).toBeGreaterThan(-1);
    expect(speechAt).toBeGreaterThan(-1);
    expect(
      captureAt,
      'Web Speech would take the microphone before the recorder — the order that lost a real capture',
    ).toBeLessThan(speechAt);
  });

  it('BRIEF 56 — nothing is AWAITED between the two acquisitions', () => {
    // The regression I shipped in Brief 55. Ordering by `await` is correct about order and wrong
    // about context: awaiting getUserMedia spends the tap's user activation, and Chromium
    // requires a live one for SpeechRecognition.start(). Transcription went from active on 4 of 6
    // production events to unavailable on 2 of 2, with capture succeeding both times.
    //
    // `capture.start()` is issued first and NOT awaited; transcription starts on the next
    // synchronous line; the await moves to where the result is needed. This asserts the window
    // between them contains no await — the property that is invisible in review and silent at
    // runtime.
    const start = ACTIVATION.indexOf('const capturePromise = startCaptureWithRetry(capture)');
    const speechAt = ACTIVATION.indexOf('transcription.start();');
    expect(start, 'the capture call was renamed — this guard is asserting over nothing').toBeGreaterThan(-1);
    expect(
      ACTIVATION.slice(start, speechAt),
      'an await between the capture request and transcription.start() spends the user gesture',
      // Matched with a trailing space rather than a word-boundary escape: written through a shell
      // heredoc, that escape arrived in this file as a literal backspace byte and lint caught it.
      // Every real await in this window is followed by whitespace anyway.
    ).not.toMatch(/await /);
    // …and the result is still awaited, so a failed capture is still detected and declared.
    expect(ACTIVATION).toMatch(/const captureStarted = await capturePromise;/);
  });

  it('a failed acquisition is RETRIED, because a denial and an unreleased track look identical', () => {
    expect(ACTIVATION).toMatch(/export const CAPTURE_RETRY_DELAYS_MS = \[/);
    expect(ACTIVATION).toMatch(/async function startCaptureWithRetry/);
    // The retry must actually re-call start(), not merely re-check a flag.
    const fn = ACTIVATION.slice(ACTIVATION.indexOf('async function startCaptureWithRetry'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect((body.match(/await capture\.start\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('§A2 — a capture that never started is DECLARED, not silently skipped', () => {
    // There used to be no `else` at all. That absence let an event dispatch, cascade, take 8
    // location fixes and close normally having recorded nothing.
    expect(ACTIVATION).toMatch(/markDegradation\(newSessionId, 'EVIDENCE_NOT_RETAINED'\)/);
    expect(ACTIVATION).toMatch(/event is running with NO recording/);
  });
});

describe('§C — every track is released, and the release is verified', () => {
  it('stop() stops each track individually and re-reads readyState', () => {
    // Dropping the recorder reference does not release the device; only track.stop() does, per
    // track. Verifying afterwards is what distinguishes a RELEASE defect from a PERMISSION
    // denial — they present identically at the next getUserMedia and have opposite fixes.
    const stop = CAPTURE.slice(CAPTURE.indexOf('  stop(): void {'));
    expect(stop).toMatch(/for \(const track of tracks\)/);
    expect(stop).toMatch(/track\.stop\(\)/);
    expect(stop).toMatch(/readyState === 'live'/);
    expect(stop).toMatch(/RELEASE DEFECT/);
  });
});

describe('§A1 — no subsystem asserts the state of another', () => {
  it('transcription does not claim that audio is recording', () => {
    // Every transcription failure message used to end "Audio is still recording." On the covert
    // event that produced this brief that sentence was false AND STORED: the same OS denial took
    // both devices. Transcription cannot see the recorder, so it no longer speaks for it.
    expect(SPEECH, 'transcription is asserting a fact it cannot observe').not.toMatch(
      /'[^']*Audio is still recording[^']*'/,
    );
    expect(SPEECH).toMatch(/does not by itself say whether audio is recording/);
  });
});
