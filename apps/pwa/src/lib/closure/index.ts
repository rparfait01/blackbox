import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { readBattery } from '@/lib/battery';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { closeAllActiveSessions, getActiveSession } from '@/lib/storage';

/**
 * Closure flow (Fix Brief 15 §E2, user side). The 3-digit pin is RETIRED. The
 * user makes a single press-and-hold gesture, evaluated entirely on-device:
 *
 *  - hold ≥ 3s   → status 'sat'   (clean)
 *  - release < 3s → status 'unsat' (DURESS)
 *
 * Only the resulting status leaves the device — never the gesture timing, never a pin.
 *
 * THIS FILE CARRIES NO CLOSURE POLICY. It reports what the ONE model on the server
 * decided (lib/closure-consent.ts, Brief 0B: consent scales to the parties actually
 * engaged). It previously hardcoded `return 'awaiting'` and its type could not even
 * express a completed close — a pre-0B assumption ("the user can never close; a
 * coordinator confirms") left behind when the model was fixed. The result: an account
 * with NO support contact closed instantly on the server and was told on screen that
 * "your support contact will confirm" — waiting on a party that does not exist. The fix
 * is to consume the model's answer, not to add a second closure path.
 *
 * §E2 INVARIANT, PRESERVED: the outcome depends on ENGAGEMENT (and tampering), never on
 * which gesture was made — `decideConsent` never reads sat vs unsat. So both gestures
 * still land on the identical screen at any given moment, and an onlooker learns nothing.
 */

export type ClosureResult = 'closed' | 'awaiting' | 'no-session';

/** POST the gesture status and READ the model's verdict. `closed` is the server saying
 *  every engaged party has assented — which, when nobody is engaged, is immediately. */
async function postClosureRequest(
  eventId: string,
  secret: string,
  status: 'sat' | 'unsat',
  reasonSecured: string,
): Promise<{ closed: boolean }> {
  const path = `/v1/events/${eventId}/closure-request`;
  const timestamp = Date.now();
  // Brief 59 — the second of the two readings. Read HERE rather than held, because closure can
  // happen minutes after the trigger and the whole point is the delta.
  const battery = await readBattery();
  const body = new TextEncoder().encode(
    JSON.stringify({ status, reasonSecured, battery: battery ? { level: battery.level } : null }),
  );
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...signed, 'Content-Type': 'application/json' },
    body: body as BodyInit,
  });
  const data = (await res.json().catch(() => null)) as { closed?: boolean } | null;
  return { closed: data?.closed === true };
}

/**
 * Send the gesture verdict and report what the model decided.
 *
 * Returns 'closed' ONLY when the server confirms the event is closed. Anything else —
 * awaiting a coordinator, an unreadable response, a network failure — is 'awaiting',
 * which is the safe direction: it never tells a survivor she is secured when the server
 * has not said so.
 */
export async function submitClosureGesture(sat: boolean, reasonSecured: string): Promise<ClosureResult> {
  const session = await getActiveSession();
  if (!session || session.status !== 'active') {
    return 'no-session';
  }
  if (uploadsEnabled && session.eventId && session.hmacSecret) {
    try {
      const { closed } = await postClosureRequest(session.eventId, session.hmacSecret, sat ? 'sat' : 'unsat', reasonSecured);
      if (closed) {
        // The event is closed server-side; tear the local session down so the app
        // returns to dormant instead of sitting in a phantom alert.
        await closeAllActiveSessions(Date.now());
        return 'closed';
      }
    } catch (error) {
      // Never claim "secured" on a failure — fall through to awaiting.
      log.error('closure-request failed', error);
    }
  }
  return 'awaiting';
}
