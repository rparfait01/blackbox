import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getActiveSession, getStoredClosurePin } from '@/lib/storage';
import { evalClosurePin } from '@/lib/crypto/pin';

/**
 * Closure flow (Brief 9 Phase D, user side). The user taps Request closure and
 * enters their 3-digit pin. The pin is an INTENT tool — evaluated ON-DEVICE and
 * NEVER transmitted. Only the resulting status leaves the device:
 *
 *  - correct pin            → status 'sat'  → coordinator window shows SAT
 *  - last digit altered     → status 'unsat' (DURESS) → "threat ongoing"
 *  - other wrong patterns   → 'wrong' (a typo); the overlay retries / locks out
 *
 * The user can NEVER close the alert — only the coordinator secures. After a
 * sat/unsat submit the user sees an awaiting-confirmation screen.
 */

export type ClosureResult = 'awaiting' | 'wrong' | 'no-session' | 'no-pin';

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
 * Evaluate the submitted pin on-device and, for sat/duress, send the STATUS
 * (never the pin) to the coordinator. Returns the verdict the overlay uses to
 * decide what to show — note that sat and duress BOTH return 'awaiting' so the
 * screen (and any onlooker) cannot tell a duress signal was sent.
 */
export async function submitClosure(digits: string, reasonSecured: string): Promise<ClosureResult> {
  const session = await getActiveSession();
  if (!session || session.status !== 'active') {
    return 'no-session';
  }
  const closurePin = await getStoredClosurePin();
  if (!closurePin) {
    return 'no-pin';
  }
  const verdict = await evalClosurePin(digits, closurePin);
  if (verdict === 'wrong') {
    return 'wrong';
  }
  if (uploadsEnabled && session.eventId && session.hmacSecret) {
    try {
      await postClosureRequest(
        session.eventId,
        session.hmacSecret,
        verdict === 'duress' ? 'unsat' : 'sat',
        reasonSecured,
      );
    } catch (error) {
      log.error('closure-request failed', error);
    }
  }
  return 'awaiting';
}
