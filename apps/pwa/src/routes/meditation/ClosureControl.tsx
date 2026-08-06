import { useEffect, useRef, useState, type PointerEvent } from 'react';

import { submitClosureGesture } from '@/lib/closure';
import {
  TAP_MS,
  holdTo,
  idleGesture,
  interrupt,
  press,
  progressOf,
  release,
  type GestureState,
} from '@/lib/closure/gesture';

/**
 * Closure control (Fix Brief 15 §E2) — the gesture that replaces the 3-digit
 * closure pin. A single press-and-hold control, disguised as a meditation
 * "session" affordance:
 *
 *   - Hold ≥ 3s  → SAT  (clean closure request)
 *   - Release < 3s → UNSAT (duress signal)
 *
 * The gesture is evaluated ENTIRELY on-device; only the resulting status
 * (sat | unsat) leaves the device — never any indication of which gesture was
 * made, never a pin. The user can never close the alert themselves; a
 * coordinator confirms.
 *
 * CRITICAL INVARIANT (asserted below + covered by a test): a clean hold and a
 * duress release land on the BYTE-IDENTICAL "Closure requested — awaiting
 * confirmation" screen — no ring, fill, haptic, sound, or color difference — so
 * an onlooker (or an aggressor watching the screen) can never tell a duress
 * signal was sent. The control is NEVER labelled with the duress meaning; that
 * is taught privately at onboarding.
 */

export function ClosureControl({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [reason, setReason] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  // The event closed outright (no support party was engaged, so the survivor's own
  // assent was the whole required set). Distinct from `awaiting`, which means a
  // coordinator IS engaged and their assent is genuinely outstanding.
  const [secured, setSecured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pressing, setPressing] = useState(false);
  /** A one-line nudge when a press was too short to be a gesture. Never says why. */
  const [hint, setHint] = useState<string | null>(null);

  const rafRef = useRef<number | null>(null);
  // The whole gesture, as one value. Brief 56 moved the decision into `@/lib/closure/gesture`
  // so it could be tested at all — inside this component it needed a DOM, a renderer and a
  // testing-library stack this project does not have, which is why a duress signal that fired on
  // every one of sixteen production closures was never caught by a test.
  const gestureRef = useRef<GestureState>(idleGesture());

  useEffect(() => {
    if (open) {
      setMounted(true);
      setReason('');
      setAwaiting(false);
      setSecured(false);
      setBusy(false);
      setProgress(0);
      setPressing(false);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!mounted) {
    return null;
  }

  function stopRaf(): void {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setPressing(false);
  }

  /** Apply whatever the machine decided. `null` means nothing leaves the device. */
  function applyDecision(decision: ReturnType<typeof release>['decision']): void {
    if (decision) {
      void submit(decision.sat);
    }
  }

  // Both gestures route through here and render whatever the ONE closure model
  // returned. The `sat` boolean is the only difference that leaves this function, and
  // the model never reads it (decideConsent branches on ENGAGEMENT, not on the gesture)
  // — so at any moment both gestures produce the identical screen. §E2 invariant intact.
  async function submit(sat: boolean): Promise<void> {
    // The gesture machine already guarantees one decision per press; this guards a second press
    // arriving while the first request is still in flight.
    if (busy) return;
    setBusy(true);
    const result = await submitClosureGesture(sat, reason.trim());
    setBusy(false);
    if (result === 'no-session') {
      onClose();
      return;
    }
    // 'closed' = the server closed it. With no support engaged that is immediate, and
    // showing "your support contact will confirm" here was the solo deadlock: waiting
    // on a party that does not exist.
    if (result === 'closed') {
      setSecured(true);
      return;
    }
    setAwaiting(true);
  }

  function tick(now: number): void {
    setProgress(progressOf(gestureRef.current, now));
    const { state, decision } = holdTo(gestureRef.current, now);
    gestureRef.current = state;
    if (decision) {
      stopRaf();
      applyDecision(decision);
      return;
    }
    if (state.startedAt === null) return; // interrupted between frames
    rafRef.current = requestAnimationFrame(tick);
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    // ═══ P0 — `awaiting` USED TO BLOCK THIS, AND IT TRAPPED HER IN HER OWN ALERT. ════════════
    //
    // Measured on a live incident: she requested closure at 88s, the sheet went to `awaiting`,
    // and from that moment EVERY press — tap or hold — was ignored. Then at 307s the server's
    // escalation cleared her assent so she "must request a SECOND time" (closure-timeout.ts, its
    // own words) — and her control had already locked itself. The design said ask again; the UI
    // made it impossible. The event was still open eleven minutes later.
    //
    // Only `busy` blocks now: that is one request genuinely in flight, and it clears in
    // milliseconds. Waiting for a coordinator is not a reason to stop listening to her.
    if (busy) return;
    setProgress(0);
    gestureRef.current = press(performance.now());
    setPressing(true);
    // ═══ BRIEF 56 — POINTER CAPTURE, AND WHY THIS ONE LINE WAS MISSING FOR 16 CLOSURES. ═════
    //
    // Without capture the element stops receiving pointer events the moment the touch drifts
    // outside its bounds, and the browser fires `pointerleave` instead. The old code routed
    // `pointerleave` into the release handler, so a finger that moved during a three-second hold
    // ended the gesture — and ended it as DURESS.
    //
    // This is the same defect Brief 15 found on the covert trigger, on a different control:
    // "a missing setPointerCapture on the hold". It was fixed there and not looked for here.
    //
    // Guarded, because a failure to capture is invisible on a desktop mouse and only appears on
    // a real finger on a real phone.
    try {
      (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      // A browser that refuses capture is not a reason to refuse the gesture. The handlers below
      // are written so that losing the pointer produces NOTHING rather than a false signal, so
      // the worst case without capture is that she has to press again.
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  /**
   * A DELIBERATE RELEASE. This is the only path that can produce a duress signal.
   *
   * ═══ WHAT PRODUCTION ACTUALLY RECORDED ═══════════════════════════════════════════════════
   *
   * Sixteen closures. Sixteen `unsat`. Zero `sat`, ever, since the production reset — and one
   * POST per closure, so nothing was overwriting a good value. `submit(true)` had never once
   * executed on a real device.
   *
   * The cause was not this branch. It was that `pointerleave` and `pointercancel` were wired to
   * this same handler, and NEITHER OF THEM IS A GESTURE. `pointercancel` is the browser taking
   * the pointer away — a system gesture, a scroll heuristic, an incoming call. `pointerleave` is
   * a finger drifting off a control it never left hold of. Both were being recorded as a survivor
   * signalling that she is being forced, and the coordinator's email path for that is titled
   * "DO NOT APPROVE".
   *
   * The early-release rule itself is unchanged and deliberate: a release before the threshold IS
   * the duress signal, with no dead zone. That is a safety design decision and it is not mine to
   * revise — see the report accompanying this change for the one open question about it.
   */
  function onPointerUp(): void {
    const held = gestureRef.current.startedAt === null ? 0 : performance.now() - gestureRef.current.startedAt;
    const { state, decision } = release(gestureRef.current, performance.now());
    gestureRef.current = state;
    stopRaf();
    // ═══ A SWALLOWED TAP MUST NOT BE SILENT. ════════════════════════════════════════════════
    //
    // Brief 56 added a 350ms floor so an accidental brush could not report duress — correct, and
    // it fixed 18-for-18. What it did not add was any way to TELL. A survivor tapping "end alert"
    // got nothing at all: no movement, no message, a control that looks broken at the moment she
    // most needs to believe it works. She reported it as being unable to close her own alert, and
    // she was right.
    //
    // The hint says only what to do. It says nothing about what an early release means, so the
    // §E2 anti-coercion property is untouched — a tap and an interrupted hold look identical.
    if (!decision && held > 0 && held < TAP_MS) {
      setHint('Press and hold until the ring completes.');
      window.setTimeout(() => setHint(null), 4000);
      return;
    }
    applyDecision(decision);
  }

  /**
   * THE GESTURE WAS INTERRUPTED — NOT COMPLETED, AND NOT DELIBERATELY ABORTED.
   *
   * Submits NOTHING and leaves the alert exactly as it was, which is the protective direction:
   * an open alert stays open, and she can press again. The alternative — treating an interruption
   * as duress — manufactures a coercion report out of a browser event, and repeated duress
   * escalates the event to TAMPERING, so the false signal compounds.
   *
   * `pointerleave` is deliberately NOT wired here or anywhere: with capture set it should not
   * fire mid-hold, and if it does the gesture is still live and must not be torn down.
   */
  function onPointerInterrupted(): void {
    gestureRef.current = interrupt(gestureRef.current).state;
    stopRaf();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="stillpoint-bg w-full max-w-md rounded-t-3xl px-8 pb-12 pt-10 text-med-text shadow-2xl transition-transform duration-300 ease-out"
        style={{ transform: shown ? 'translateY(0)' : 'translateY(100%)' }}
        onClick={(event) => event.stopPropagation()}
      >
        {secured ? (
          // Closed. Reached identically by a clean hold and a duress release — the model
          // never reads the gesture — so this reveals nothing to an onlooker. Wording
          // stays inside the meditation cover story.
          <div className="flex min-h-[20rem] flex-col items-center justify-center text-center">
            <p className="font-serif text-xl font-light tracking-[0.1em] text-med-text/80">Session ended.</p>
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-med-text/45">
              You can close this whenever you are ready.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-8 rounded-full border border-med-text/40 px-8 py-3 text-sm font-medium text-med-text"
            >
              Done
            </button>
          </div>
        ) : awaiting ? (
          // IDENTICAL for sat and unsat — do not branch this view on the gesture. Only
          // reached when a support party is ACTUALLY engaged, so the copy is now true.
          //
          // ═══ THE CONTROL STAYS ON SCREEN. ═══════════════════════════════════════════════
          //
          // This view used to REPLACE the hold control, so once she had asked once there was no
          // button left to press. Combined with the server clearing her assent at the 180s
          // escalation — so that she "must request a SECOND time" — she was locked out of ending
          // her own alert while the event stayed open. Eleven minutes, on a live incident.
          //
          // Waiting is not a terminal state. She can always ask again.
          <div className="flex min-h-[20rem] flex-col items-center justify-center text-center">
            <p className="animate-breath-label motion-reduce:animate-none font-serif text-xl font-light tracking-[0.1em] text-med-text/80">
              Closure requested — awaiting confirmation…
            </p>
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-med-text/45">
              Your support contact will confirm. This may take a few minutes.
            </p>
            <div className="mt-8 flex flex-col items-center">
              <button
                type="button"
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerInterrupted}
                onLostPointerCapture={onPointerInterrupted}
                disabled={busy}
                aria-label="Hold to request closure again"
                className="relative flex h-28 w-28 touch-none select-none items-center justify-center rounded-full border border-med-text/30 [-webkit-touch-callout:none] [-webkit-user-select:none]"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-med-text/70"
                  style={{ clipPath: `inset(${(1 - progress) * 100}% 0 0 0)`, opacity: pressing ? 1 : 0 }}
                />
                <span className="select-none font-serif text-sm font-light tracking-[0.14em] text-med-text/80">
                  {busy ? '…' : 'Ask again'}
                </span>
              </button>
              {hint ? <p className="mt-3 max-w-xs text-[11px] text-med-text/55">{hint}</p> : null}
            </div>
          </div>
        ) : (
          <>
            <p className="mb-6 text-center font-serif text-lg font-light tracking-[0.08em] text-med-text/70">
              Request closure
            </p>

            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              className="mb-8 w-full border-b border-med-text/25 bg-transparent py-2 text-center text-sm text-med-text outline-none placeholder:text-med-text/30"
            />

            {/* The single closure control. Invariant appearance: it shows a hold
                progress while pressed, but says nothing about the early-release
                meaning. The progress ring is press-time affordance only and is
                gone the instant the (identical) awaiting screen appears. */}
            <div className="flex flex-col items-center">
              <button
                type="button"
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                // An interruption is not a signal. See onPointerInterrupted.
                onPointerCancel={onPointerInterrupted}
                onLostPointerCapture={onPointerInterrupted}
                disabled={busy}
                aria-label="Hold to request closure"
                className="relative flex h-40 w-40 touch-none select-none items-center justify-center rounded-full border border-med-text/30 [-webkit-touch-callout:none] [-webkit-user-select:none]"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-med-text/70"
                  style={{ clipPath: `inset(${(1 - progress) * 100}% 0 0 0)`, opacity: pressing ? 1 : 0 }}
                />
                <span className="select-none font-serif text-base font-light tracking-[0.18em] text-med-text/80">
                  {busy ? '…' : 'Hold to close'}
                </span>
              </button>
              <p className="mt-5 max-w-xs text-center text-[11px] leading-relaxed text-med-text/40">
                {hint ?? 'Press and hold until the ring completes to request closure.'}
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="mt-6 block w-full text-center text-sm text-med-text/45 underline"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
