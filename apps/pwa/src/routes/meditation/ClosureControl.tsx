import { useEffect, useRef, useState, type PointerEvent } from 'react';

import { submitClosureGesture } from '@/lib/closure';

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
const HOLD_MS = 3000;

export function ClosureControl({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [reason, setReason] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pressing, setPressing] = useState(false);

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setReason('');
      setAwaiting(false);
      setBusy(false);
      setProgress(0);
      setPressing(false);
      firedRef.current = false;
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
    startRef.current = null;
    setPressing(false);
  }

  // Both outcomes route through here and set the SAME awaiting state. The only
  // difference that ever leaves this function is the `sat` boolean sent to the
  // server; the on-screen result is identical. (Brief 15 §E2 invariant.)
  async function submit(sat: boolean): Promise<void> {
    if (firedRef.current || busy) return;
    firedRef.current = true;
    setBusy(true);
    const result = await submitClosureGesture(sat, reason.trim());
    setBusy(false);
    if (result === 'no-session') {
      onClose();
      return;
    }
    setAwaiting(true);
  }

  function tick(now: number): void {
    if (startRef.current === null) return;
    const elapsed = now - startRef.current;
    setProgress(Math.min(elapsed / HOLD_MS, 1));
    if (elapsed >= HOLD_MS) {
      stopRaf();
      void submit(true); // held the full duration → clean
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    if (busy || awaiting) return;
    firedRef.current = false;
    setProgress(0);
    startRef.current = performance.now();
    setPressing(true);
    rafRef.current = requestAnimationFrame(tick);
  }

  function onPointerUp(): void {
    if (startRef.current === null) return;
    const elapsed = performance.now() - startRef.current;
    stopRaf();
    // Released before the threshold and the clean-hold didn't already fire →
    // this is the duress signal. No dead zone: any early release is UNSAT.
    if (!firedRef.current && elapsed < HOLD_MS) {
      void submit(false);
    }
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
        {awaiting ? (
          // IDENTICAL for sat and unsat — do not branch this view on the gesture.
          <div className="flex min-h-[20rem] flex-col items-center justify-center text-center">
            <p className="animate-breath-label motion-reduce:animate-none font-serif text-xl font-light tracking-[0.1em] text-med-text/80">
              Closure requested — awaiting confirmation…
            </p>
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-med-text/45">
              Your support contact will confirm. This may take a few minutes.
            </p>
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
                onPointerLeave={onPointerUp}
                onPointerCancel={onPointerUp}
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
                Press and hold until the ring completes to request closure.
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
