import { useEffect, useRef } from 'react';

/**
 * Calls `onTimeout` after `timeoutMs` of no user interaction. Any pointer,
 * key, touch, or wheel event resets the countdown. Used by the dashboard to
 * auto-return to the meditation facade after 60s of inactivity.
 */
export function useInactivityTimer(timeoutMs: number, onTimeout: () => void): void {
  const savedCallback = useRef(onTimeout);

  useEffect(() => {
    savedCallback.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    let timer = window.setTimeout(() => savedCallback.current(), timeoutMs);

    const reset = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => savedCallback.current(), timeoutMs);
    };

    const events: Array<keyof WindowEventMap> = [
      'pointerdown',
      'pointermove',
      'keydown',
      'touchstart',
      'wheel',
    ];
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));

    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [timeoutMs]);
}
