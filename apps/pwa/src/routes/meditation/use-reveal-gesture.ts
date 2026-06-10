import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

export interface RevealGesture {
  /** Hold progress, 0 → 1. */
  progress: number;
  isHolding: boolean;
  handlers: {
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
  };
}

/**
 * Press-and-hold gesture on the breathing circle. Fills `progress` over
 * `holdMs`; releasing early resets it. Completing the hold fires `onComplete`
 * once — which reveals the dashboard for inspection. This is NOT an activation
 * trigger; it only navigates the user to their own dashboard.
 */
export function useRevealGesture(holdMs: number, onComplete: () => void): RevealGesture {
  const [progress, setProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const completedRef = useRef(false);
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
      completedRef.current = false;
      startRef.current = performance.now();
      setIsHolding(true);
      rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

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
      onPointerUp: stop,
      onPointerLeave: stop,
      onPointerCancel: stop,
    },
  };
}
