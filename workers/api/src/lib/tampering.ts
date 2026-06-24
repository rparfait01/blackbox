/**
 * Repetition → tampering escalation + disposition (Fix Brief 15 §E3/§E4).
 *
 * A single duress (UNSAT) closure signal is DURESS — the coordinator validates
 * with judgment. But REPEATED duress signals within a short window mean someone
 * is hammering the close control: an aggressor, or an escalating situation. The
 * server counts them invisibly (the device render is identical for signal #1…N)
 * and, past a threshold, escalates the event's disposition to TAMPERING, which a
 * coordinator can never clean-close without an explicit, logged override.
 *
 * SINGLE CONFIG for the threshold + window (Royce tunes the final value).
 */

/** ≥ this many UNSAT signals… */
export const TAMPERING_THRESHOLD = 2;
/** …within this rolling window (ms) escalates DURESS → TAMPERING. */
export const TAMPERING_WINDOW_MS = 120_000;

export type Disposition = 'SAT' | 'DURESS' | 'TAMPERING' | 'FEED_LOST';

/** The mandatory, verbatim note on a feed-loss closure (Brief 16 §3). */
export const FEED_LOST_NOTE = 'Safety is at risk. Session closure is NOT an indication of safety.';

/**
 * Disposition from server truth only. A feed-loss close (the device went dark
 * after emergency was notified) is recorded DISTINCTLY and outranks everything —
 * it is explicitly NOT a safe close. Otherwise tampering > duress > clean; a
 * TAMPERING/DURESS event must never be reported as a clean "safe" close.
 */
export function disposition(
  closeRequestStatus: string | null,
  tamperingAt: number | null,
  feedLostAt: number | null = null,
): Disposition {
  if (feedLostAt != null) return 'FEED_LOST';
  if (tamperingAt != null) return 'TAMPERING';
  if (closeRequestStatus === 'unsat') return 'DURESS';
  return 'SAT';
}

/** Whether a duress count observed within the window crosses the escalation line. */
export function crossesTamperingThreshold(duressCountInWindow: number): boolean {
  return duressCountInWindow >= TAMPERING_THRESHOLD;
}
