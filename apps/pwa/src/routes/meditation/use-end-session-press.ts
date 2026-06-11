import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

/** A quick tap (under this) keeps the W2 behavior: reset the visible timer. */
const TAP_MAX_MS = 500;
/** A deliberate hold (past this) opens the disguised pin-entry overlay. */
const HOLD_MS = 2500;

export interface EndSessionPress {
  /** Hold progress 0 → 1, for the subtle filling line beneath "End session". */
  progress: number;
  handlers: {
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
  };
}

/**
 * The "End session" control carries two gestures so the covert closure path
 * never disturbs the ordinary one:
 *
 *  - tap  (< 500ms)  → onTap(): reset the timer, exactly as in W2.
 *  - hold (> 2500ms) → onHold(): open the pin-entry overlay. The hold does NOT
 *    reset the timer — only the tap does — so the visible session is undisturbed.
 *
 * A release between 500ms and 2500ms does nothing (an aborted hold).
 */
export function useEndSessionPress(onTap: () => void, onHold: () => void): EndSessionPress {
  const [progress, setProgress] = useState(0);

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const onTapRef = useRef(onTap);
  const onHoldRef = useRef(onHold);

  useEffect(() => {
    onTapRef.current = onTap;
    onHoldRef.current = onHold;
  }, [onTap, onHold]);

  const cancelRaf = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(
    (now: number): void => {
      if (startRef.current === null) {
        return;
      }
      const elapsed = now - startRef.current;
      setProgress(Math.min(elapsed / HOLD_MS, 1));
      if (elapsed >= HOLD_MS) {
        if (!completedRef.current) {
          completedRef.current = true;
          cancelRaf();
          setProgress(0);
          onHoldRef.current();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [cancelRaf],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent): void => {
      event.preventDefault();
      completedRef.current = false;
      startRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  const onRelease = useCallback((): void => {
    cancelRaf();
    setProgress(0);
    const start = startRef.current;
    startRef.current = null;
    if (completedRef.current || start === null) {
      return; // hold already fired, or no active press
    }
    if (performance.now() - start < TAP_MAX_MS) {
      onTapRef.current();
    }
  }, [cancelRaf]);

  useEffect(() => cancelRaf, [cancelRaf]);

  return {
    progress,
    handlers: {
      onPointerDown,
      onPointerUp: onRelease,
      onPointerLeave: onRelease,
      onPointerCancel: onRelease,
    },
  };
}
