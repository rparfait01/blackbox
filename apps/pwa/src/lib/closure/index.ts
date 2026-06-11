import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getActiveSession, getStoredDuressPin, getStoredPin } from '@/lib/storage';
import { pinHashWithSalt, verifyPin, type StoredPin } from '@/lib/crypto/pin';

/**
 * Closure flow (W6, user side). The user enters a 4-digit pin in the disguised
 * overlay. We decide LOCALLY which pin it is — normal, duress, or wrong — and
 * only contact the Worker for the first two:
 *
 *  - normal pin  → close-request with duress:false (contact gets Approve/Hold)
 *  - duress pin  → close-request with duress:true  (contact gets a DURESS alert
 *                  with no approve button; recording continues no matter what)
 *  - wrong pin   → nothing leaves the device; the overlay closes silently
 *
 * The Worker never sees or validates the pin: closure is gated by the contact's
 * approval, not by the server. We still forward the salted hash, which the
 * Worker records (in audit, never logged) for the event trail.
 */

export type ClosureResult = 'submitted' | 'wrong' | 'no-session';

async function postCloseRequest(
  eventId: string,
  secret: string,
  stored: StoredPin,
  duress: boolean,
): Promise<void> {
  const path = `/v1/events/${eventId}/close-request`;
  const timestamp = Date.now();
  const body = new TextEncoder().encode(
    JSON.stringify({ pinHashWithSalt: pinHashWithSalt(stored), duress }),
  );
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

  let matched: StoredPin | null = null;
  let isDuress = false;
  if (normal && (await verifyPin(digits, normal))) {
    matched = normal;
  } else if (duress && (await verifyPin(digits, duress))) {
    matched = duress;
    isDuress = true;
  }

  if (!matched) {
    return 'wrong';
  }

  // Send the request if we can reach the backend and the event exists. If the
  // event has not been created yet (very early closure) we still report
  // 'submitted' so the overlay stays covert — the contact simply won't receive
  // it, which is an acceptable edge for the pilot.
  if (uploadsEnabled && session.eventId && session.hmacSecret) {
    try {
      await postCloseRequest(session.eventId, session.hmacSecret, matched, isDuress);
    } catch (error) {
      log.error('close-request failed', error);
    }
  }
  return 'submitted';
}
