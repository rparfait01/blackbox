import { describe, expect, it } from 'vitest';

import { HOLD_MS, TAP_MS, holdTo, idleGesture, interrupt, press, progressOf, release } from './gesture';

/**
 * BRIEF 56 — WHAT MAY AND MAY NOT PRODUCE A DURESS SIGNAL.
 *
 * Production recorded sixteen closures and sixteen duress reports. Zero clean closures, ever.
 * These are the cases that were wrong, written as the sequences a phone actually produces.
 *
 * Per the ratified rule, each was verified to FAIL with the fix reverted — i.e. with `interrupt`
 * routed to `release`, which is what the component did.
 */

const T0 = 1_000_000; // an arbitrary point on the performance timeline

describe('an interruption is not a survivor speaking', () => {
  it('the browser cancelling the pointer submits NOTHING', () => {
    // `pointercancel`: a system edge-swipe, a scroll heuristic, an incoming call. Under the old
    // wiring this reported that she was being forced to close the alert.
    const held = press(T0);
    const { decision } = interrupt(held);
    expect(decision, 'an interrupted gesture reported duress').toBeNull();
  });

  it('losing pointer capture submits NOTHING', () => {
    const held = press(T0);
    expect(interrupt(held).decision).toBeNull();
  });

  it('an interruption leaves no half-state that a later event can resolve into a signal', () => {
    // The dangerous shape: interrupt clears the press but a stray release still evaluates it.
    const after = interrupt(press(T0)).state;
    expect(release(after, T0 + 500).decision, 'a stray release after an interruption fired').toBeNull();
    expect(holdTo(after, T0 + HOLD_MS + 1).decision).toBeNull();
  });

  it('interrupting when nothing is pressed is inert', () => {
    expect(interrupt(idleGesture()).decision).toBeNull();
  });
});

describe('the two real gestures still mean what they mean', () => {
  it('holding to the threshold submits SAT — the path that had never once executed', () => {
    const { decision } = holdTo(press(T0), T0 + HOLD_MS);
    expect(decision).toEqual({ submit: true, sat: true });
  });

  it('a deliberate early release submits UNSAT — the duress rule is unchanged', () => {
    // Untouched on purpose. An early release IS the signal, with no dead zone; that is a safety
    // design decision and this change does not revisit it.
    const { decision } = release(press(T0), T0 + 900);
    expect(decision).toEqual({ submit: true, sat: false });
  });

  it('one millisecond under the hold threshold is still duress', () => {
    expect(release(press(T0), T0 + HOLD_MS - 1).decision).toEqual({ submit: true, sat: false });
  });

  it('A TAP PRODUCES NOTHING — the branch whose absence made duress the default', () => {
    // Eighteen production closures, eighteen duress reports, zero clean ones. The rule said any
    // release before 3s was duress with no dead zone, so touching the button at all reported
    // coercion. There was no neutral interaction with that control.
    expect(release(press(T0), T0 + 80).decision, 'a tap reported duress').toBeNull();
    expect(release(press(T0), T0 + TAP_MS - 1).decision).toBeNull();
  });

  it('the duress signal still exists, immediately above the tap threshold', () => {
    // The floor is on INTENT, not a grace period: a deliberate press-and-release is unchanged.
    expect(release(press(T0), T0 + TAP_MS).decision).toEqual({ submit: true, sat: false });
    expect(release(press(T0), T0 + 1200).decision).toEqual({ submit: true, sat: false });
  });

  it('a tap leaves no half-state — the next press is a clean start', () => {
    const after = release(press(T0), T0 + 100).state;
    expect(after.fired, 'a tap must not consume the gesture').toBe(false);
    expect(release(press(T0 + 500), T0 + 2000).decision).toEqual({ submit: true, sat: false });
  });
});

describe('a decision is emitted exactly once per press', () => {
  it('the release that always follows a completed hold does not contradict it', () => {
    // The finger always comes up. If that release were evaluated, every successful closure would
    // chase itself with a duress report — and the duress would be the LAST word.
    const { state } = holdTo(press(T0), T0 + HOLD_MS);
    expect(release(state, T0 + HOLD_MS + 120).decision, 'a completed hold was followed by duress').toBeNull();
  });

  it('the animation frame cannot fire the clean decision twice', () => {
    const first = holdTo(press(T0), T0 + HOLD_MS);
    expect(first.decision).toEqual({ submit: true, sat: true });
    expect(holdTo(first.state, T0 + HOLD_MS + 16).decision).toBeNull();
  });

  it('a second press after a completed one is a fresh decision', () => {
    const { state } = holdTo(press(T0), T0 + HOLD_MS);
    expect(state.fired).toBe(true);
    const again = press(T0 + 9_000);
    expect(release(again, T0 + 9_400).decision).toEqual({ submit: true, sat: false });
  });

  it('a release with no press does nothing', () => {
    expect(release(idleGesture(), T0).decision).toBeNull();
  });
});

describe('the press-time affordance', () => {
  it('progress runs 0 to 1 across the hold and never past it', () => {
    const p = press(T0);
    expect(progressOf(p, T0)).toBe(0);
    expect(progressOf(p, T0 + HOLD_MS / 2)).toBeCloseTo(0.5, 5);
    expect(progressOf(p, T0 + HOLD_MS * 3)).toBe(1);
  });

  it('progress is zero when nothing is held', () => {
    expect(progressOf(idleGesture(), T0)).toBe(0);
  });
});
