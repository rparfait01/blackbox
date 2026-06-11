import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getActiveSession, getStoredDuressPin, getStoredPin } from '@/lib/storage';
import { verifyPin } from '@/lib/crypto/pin';

/**
 * Closure flow (Fix Brief 1 #3/#4, user side). The user enters a 4-digit code in
 * the disguised overlay. We decide LOCALLY which code it is — normal, duress, or
 * wrong — for covert UX (duress and normal look identical, a wrong code clears
 * silently with no network call). The AUTHORITATIVE decision is the Worker's:
 * the raw code is POSTed to `/v1/events/:id/standdown`, which re-verifies it
 * against the account's lock/duress hash and:
 *
 *  - lock code   → closes the event server-side (server-authoritative). The
 *                  session monitor sees `status=closed` and tears capture down.
 *  - duress code → ESCALATES (duress alert) and does NOT close; recording
 *                  continues. The event closes later only on confirmed voice
 *                  contact (a contact-side stand-down).
 *  - wrong code  → nothing leaves the device; the overlay clears silently.
 */

export type ClosureResult = 'submitted' | 'wrong' | 'no-session';

async function postStandDown(eventId: string, secret: string, code: string): Promise<void> {
  const path = `/v1/events/${eventId}/standdown`;
  const timestamp = Date.now();
  const body = new TextEncoder().encode(JSON.stringify({ code }));
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });
  await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...signed, 'Content-Type': 'application/json' },
    body: body as BodyInit,
  });
}

/**
 * Evaluate a submitted pin against the stored pins and, when it matches, send
 * the closure request. Returns the outcome the overlay uses to decide what to
 * show — note that duress and normal both return 'submitted' so the screen
 * (and any observer) cannot tell them apart.
 */
export async function submitClosurePin(digits: string): Promise<ClosureResult> {
  const session = await getActiveSession();
  if (!session || session.status !== 'active') {
    return 'no-session';
  }

  const [normal, duress] = await Promise.all([getStoredPin(), getStoredDuressPin()]);

  const isNormal = normal ? await verifyPin(digits, normal) : false;
  const isDuress = !isNormal && duress ? await verifyPin(digits, duress) : false;

  if (!isNormal && !isDuress) {
    return 'wrong';
  }

  // Hand the raw code to the Worker, which re-verifies it authoritatively and
  // either closes the event (lock code) or escalates without closing (duress).
  // If the event has not been created yet (very early closure) we still report
  // 'submitted' so the overlay stays covert.
  if (uploadsEnabled && session.eventId && session.hmacSecret) {
    try {
      await postStandDown(session.eventId, session.hmacSecret, digits);
    } catch (error) {
      log.error('standdown failed', error);
    }
  }
  return 'submitted';
}
