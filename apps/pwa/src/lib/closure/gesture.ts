/**
 * THE CLOSURE GESTURE, AS A DECISION RATHER THAN A SET OF EVENT HANDLERS.
 *
 * ═══ WHY THIS IS ITS OWN MODULE ══════════════════════════════════════════════════════════════
 *
 * Sixteen closures in production. Sixteen `unsat`. Zero `sat`, ever — one POST each, so nothing
 * was overwriting a good value. The clean-hold path had never once executed on a real device, and
 * every alert this product has closed carries "she is being forced" in its record, under a
 * coordinator email path titled "DO NOT APPROVE".
 *
 * The cause was not the rule. It was that three different pointer events were wired to one
 * handler whose only branch was "early release ⇒ duress":
 *
 *     onPointerUp     — a person releasing.        A GESTURE.
 *     onPointerLeave  — a finger drifting off a control it never let go of.   NOT a gesture.
 *     onPointerCancel — the browser taking the pointer: a system swipe, a scroll
 *                       heuristic, an incoming call.                          NOT a gesture.
 *
 * Two thirds of the inputs to a duress signal were not the survivor doing anything.
 *
 * Living inside a component, that distinction was untestable without a DOM, a renderer and a
 * testing-library stack this project does not have — so it was never tested, and the defect sat
 * in production for sixteen closures. As a pure function over an event sequence it is provable
 * with nothing at all, which is the point: the ratified rule is that behaviour is proven by a
 * test that fails when the fix is reverted, and that is only possible if the behaviour is
 * reachable from a test.
 *
 * ═══ WHAT IS DELIBERATELY UNCHANGED ══════════════════════════════════════════════════════════
 *
 * A deliberate release before the threshold IS the duress signal, with NO DEAD ZONE. That is a
 * safety design decision, it was made by the product owner, and this refactor does not revisit
 * it. What changed is only which inputs are allowed to reach it.
 */

/** How long the control must be held for a CLEAN closure request. */
export const HOLD_MS = 3000;

/** What the gesture decided. `null` means nothing leaves the device. */
export type GestureDecision =
  /** Held to the threshold — a clean closure request. */
  | { submit: true; sat: true }
  /** Released deliberately before the threshold — the duress signal. */
  | { submit: true; sat: false }
  /** Nothing happened that the server should hear about. */
  | null;

export interface GestureState {
  /** When the press began, on the performance timeline. null = no press in progress. */
  startedAt: number | null;
  /** True once a decision has been emitted for this press, so it cannot emit twice. */
  fired: boolean;
}

export function idleGesture(): GestureState {
  return { startedAt: null, fired: false };
}

/** A press begins. Any prior press is discarded — a new press is a new decision. */
export function press(now: number): GestureState {
  return { startedAt: now, fired: false };
}

/**
 * Time advanced while the control is held. Emits the CLEAN decision at the threshold, once.
 *
 * The caller drives this from its animation frame, so `now` and the value handed to `press`
 * must come from the same clock.
 */
export function holdTo(state: GestureState, now: number): { state: GestureState; decision: GestureDecision } {
  if (state.startedAt === null || state.fired) {
    return { state, decision: null };
  }
  if (now - state.startedAt >= HOLD_MS) {
    return { state: { startedAt: null, fired: true }, decision: { submit: true, sat: true } };
  }
  return { state, decision: null };
}

/**
 * THE PERSON RELEASED. The only input that can produce a duress signal.
 *
 * A release after the clean hold already fired produces nothing — the finger always comes up, and
 * evaluating that would make every successful closure chase itself with a contradicting duress
 * report.
 */
export function release(state: GestureState, now: number): { state: GestureState; decision: GestureDecision } {
  if (state.startedAt === null || state.fired) {
    return { state: idleGesture(), decision: null };
  }
  const held = now - state.startedAt;
  return {
    state: { startedAt: null, fired: true },
    decision: held < HOLD_MS ? { submit: true, sat: false } : { submit: true, sat: true },
  };
}

/**
 * THE GESTURE WAS INTERRUPTED — not completed, and not deliberately abandoned.
 *
 * Emits nothing and leaves the alert exactly as it was, which is the protective direction: an
 * open alert stays open and she can press again. Treating an interruption as duress manufactures
 * a coercion report out of a browser event, and repeated duress escalates the event to TAMPERING,
 * so a false signal there compounds rather than washing out.
 */
export function interrupt(state: GestureState): { state: GestureState; decision: GestureDecision } {
  if (state.startedAt === null) {
    return { state, decision: null };
  }
  return { state: idleGesture(), decision: null };
}

/** How far through the hold, 0..1 — the press-time affordance only. */
export function progressOf(state: GestureState, now: number): number {
  if (state.startedAt === null) return 0;
  return Math.min((now - state.startedAt) / HOLD_MS, 1);
}
