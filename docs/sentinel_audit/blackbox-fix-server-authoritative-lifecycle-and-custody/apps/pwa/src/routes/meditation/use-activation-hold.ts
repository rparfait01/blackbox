import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

export interface ActivationHold {
  /** Hold progress, 0 → 1. */
  progress: number;
  isHolding: boolean;
  handlers: {
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onPointerLeave: (event: PointerEvent) => void;
    onPointerCancel: (event: PointerEvent) => void;
  };
}

/**
 * Press-and-hold gesture on the breathing circle. Fills `progress` over
 * `holdMs`; releasing early resets it. Completing the hold fires `onComplete`
 * once.
 *
 * This is a covert activation trigger: completion produces no visible output.
 * The progress ring is the only on-screen feedback, and it reads as part of the
 * meditation interaction. Once activated, the session gives no on-device
 * feedback of any kind — the system records and reaches, it does not reassure.
 */
export function useActivationHold(holdMs: number, onComplete: () => void): ActivationHold {
  const [progress, setProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  // True once the pointer is captured on this press. While captured we do NOT
  // abort the hold on pointerleave/pointercancel (see the handlers below).
  const capturedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const stop = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    startRef.current = null;
    setIsHolding(false);
    setProgress(0);
  }, []);

  const tick = useCallback(
    (now: number): void => {
      if (startRef.current === null) {
        return;
      }
      const elapsed = now - startRef.current;
      const next = Math.min(elapsed / holdMs, 1);
      setProgress(next);

      if (next >= 1) {
        if (!completedRef.current) {
          completedRef.current = true;
          stop();
          onCompleteRef.current();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [holdMs, stop],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent): void => {
      event.preventDefault();
      // Capture the pointer for the whole press (Brief 15 amendment — the real
      // Hidden-mode trigger bug). Without this the mobile browser reclaims the
      // press as a scroll/pan and fires pointercancel, or the finger drifts a few
      // px off the orb and fires pointerleave — either one silently aborted the
      // hold so activation never completed. A desktop mouse held still never
      // reproduced it. With capture, every later pointer event for this press
      // (including the release) is delivered to this element.
      capturedRef.current = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        capturedRef.current = true;
      } catch {
        /* capture unsupported/invalid pointer — fall back to uncaptured behavior */
      }
      completedRef.current = false;
      startRef.current = performance.now();
      setIsHolding(true);
      rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  // Release = end of the press. An early release (short tap) resets without
  // firing; only the full hold activates, so an innocent tap still does nothing.
  const onPointerUp = useCallback(
    (event: PointerEvent): void => {
      if (capturedRef.current) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        capturedRef.current = false;
      }
      stop();
    },
    [stop],
  );

  // Once the pointer is captured, IGNORE pointerleave/pointercancel — on mobile
  // they fire spuriously mid-press and were the abort that killed the gesture. A
  // genuine release still arrives as pointerup (capture guarantees delivery). If
  // capture wasn't available, preserve the original safety and reset here.
  const onPointerLeaveOrCancel = useCallback((): void => {
    if (capturedRef.current) {
      return;
    }
    stop();
  }, [stop]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return {
    progress,
    isHolding,
    handlers: {
      onPointerDown,
      onPointerUp,
      onPointerLeave: onPointerLeaveOrCancel,
      onPointerCancel: onPointerLeaveOrCancel,
    },
  };
}
