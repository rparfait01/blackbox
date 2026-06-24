import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getActiveSession } from '@/lib/storage';

/**
 * Closure flow (Fix Brief 15 §E2, user side). The 3-digit pin is RETIRED. The
 * user makes a single press-and-hold gesture, evaluated entirely on-device:
 *
 *  - hold ≥ 3s   → status 'sat'   (clean) → coordinator window shows SAT
 *  - release < 3s → status 'unsat' (DURESS) → "threat ongoing"
 *
 * Only the resulting status leaves the device — never the gesture timing, never
 * a pin. The user can NEVER close the alert themselves; a coordinator confirms.
 * Both gestures return 'awaiting' so the device screen (and any onlooker) can
 * never tell a duress signal was sent.
 */

export type ClosureResult = 'awaiting' | 'no-session';

async function postClosureRequest(
  eventId: string,
  secret: string,
  status: 'sat' | 'unsat',
  reasonSecured: string,
): Promise<void> {
  const path = `/v1/events/${eventId}/closure-request`;
  const timestamp = Date.now();
  const body = new TextEncoder().encode(JSON.stringify({ status, reasonSecured }));
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });
  await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...signed, 'Content-Type': 'application/json' },
    body: body as BodyInit,
  });
}

/**
 * Send the gesture verdict (sat = clean, false = duress) to the coordinator as a
 * STATUS only. Returns 'awaiting' for BOTH outcomes so the overlay shows the
 * identical awaiting-confirmation screen (§E2 invariant).
 */
export async function submitClosureGesture(sat: boolean, reasonSecured: string): Promise<ClosureResult> {
  const session = await getActiveSession();
  if (!session || session.status !== 'active') {
    return 'no-session';
  }
  if (uploadsEnabled && session.eventId && session.hmacSecret) {
    try {
      await postClosureRequest(session.eventId, session.hmacSecret, sat ? 'sat' : 'unsat', reasonSecured);
    } catch (error) {
      log.error('closure-request failed', error);
    }
  }
  return 'awaiting';
}
