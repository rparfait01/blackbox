import { useRef, type PointerEvent } from 'react';

/** Two taps within this window count as a double-tap (Brief 30). */
export const DOUBLE_TAP_MS = 400;

/**
 * The ONE covert double-tap detector, shared by both display skins (Brief 30).
 * Detected on POINTERDOWN — not click — because a touch `click` is synthesized late
 * and the second tap of a double-tap is fused/eaten on iOS Safari; pointerdown fires
 * immediately and reliably per tap on iOS Safari and Android Chrome. Two pointerdowns
 * within DOUBLE_TAP_MS fire `onDouble`; a single stray tap does nothing. The gesture
 * carries NO trigger logic and NO active-state — it is only an input that calls the
 * single `triggerAlert()` core. Spread the returned handler on a `touch-manipulation`
 * element so the browser's own double-tap-to-zoom never competes for the gesture.
 */
export function useDoubleTap(onDouble: () => void): { onPointerDown: (e: PointerEvent) => void } {
  const lastTapRef = useRef(0);
  return {
    onPointerDown: (e: PointerEvent): void => {
      e.preventDefault();
      const t = performance.now();
      if (t - lastTapRef.current <= DOUBLE_TAP_MS) {
        lastTapRef.current = 0;
        onDouble();
      } else {
        lastTapRef.current = t;
      }
    },
  };
}
