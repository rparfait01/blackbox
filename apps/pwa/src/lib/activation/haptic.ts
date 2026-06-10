import { log } from '@/lib/log';

/** Two long pulses: 800ms vibrate, 200ms pause, 800ms vibrate. */
export const DELIVERY_HAPTIC_PATTERN: readonly number[] = [800, 200, 800];

/**
 * The one minimal on-device acknowledgment: fires ONLY when the backend
 * confirms the contact's notification was delivered. That confirmation does not
 * exist until W5, so this is implemented but intentionally NOT called in W2 —
 * there is nothing to acknowledge yet. W5 wires it into the delivery-confirmed
 * path. It must never fire on local activation (that would be an observable
 * tell with no help actually reached).
 */
export function fireDeliveryHaptic(): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([...DELIVERY_HAPTIC_PATTERN]);
    }
  } catch (error) {
    log.error('delivery haptic failed', error);
  }
}
