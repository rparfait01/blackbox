/**
 * Contact consent (Contact Consent Gating brief).
 *
 * A Designated Contact must AGREE to the role before they are ever notified. This
 * module owns the SMS side of that agreement — the outbound confirmation ask and
 * the copy for each reply — and is the single source of truth for the exact
 * message text, which must stay byte-identical to what was filed for A2P campaign
 * registration (the live behaviour and the paperwork have to match, or the filing
 * is rejected again).
 *
 * Consent is established PER CHANNEL. This file is SMS only:
 *   - LINE contacts consent by the pairing act (confirmed at QR bind).
 *   - email is retiring and is grandfathered (0030 backfill).
 * so nothing here ever runs for a non-SMS contact.
 */

import { sendSms } from '../channels/twilio-sms';
import type { Env } from '../types';

/**
 * Is the consent gate ARMED? When false (the default), the whole consent layer is a
 * no-op for delivery: alerts reach every reachable contact exactly as before, and
 * Armed means "has a reachable recipient" as before. Status is still tracked and
 * confirmation SMS still fire — the infrastructure runs, the gate just doesn't bite.
 * Flip CONSENT_GATE_ENFORCED to 'true' to arm it once the pilot is confirmed.
 */
export function consentGateEnforced(env: Env): boolean {
  return env.CONSENT_GATE_ENFORCED === 'true';
}

/**
 * The one message a `pending` SMS contact receives, and nothing else until they
 * reply. VERBATIM — this string is the A2P Call-to-Action filing. Do not reword.
 */
export function confirmationAsk(survivorName: string): string {
  return `BLACK BOX: ${survivorName} added you as a safety contact. You may receive an alert if they activate the app. Reply YES to confirm, NO to decline. Msg&data rates may apply.`;
}

/** Sent once on YES. */
export function confirmedReply(survivorName: string): string {
  return `BLACK BOX: You're confirmed as ${survivorName}'s safety contact. Reply HELP for info, STOP to opt out anytime.`;
}

/** Sent once on NO. */
export function declinedReply(survivorName: string): string {
  return `BLACK BOX: Understood — you will not receive alerts from ${survivorName}. No further messages will be sent.`;
}

/** Sent on HELP. */
export function helpReply(): string {
  return `BLACK BOX safety-contact alerts. A person you know added you so you can be notified if they trigger an emergency. Reply YES to confirm, STOP to opt out. Msg&data rates may apply.`;
}

/**
 * Fire the confirmation ask to a pending SMS contact. Best-effort and never throws
 * into the caller: a contact-save must not fail because an SMS provider hiccupped —
 * the contact is stored as pending regardless, and the survivor sees that state.
 * Returns whether the send was accepted by the provider (for logging/tests).
 */
export async function sendConfirmationAsk(env: Env, toPhone: string, survivorName: string): Promise<boolean> {
  try {
    const res = await sendSms(env, toPhone, confirmationAsk(survivorName));
    return res.ok;
  } catch {
    return false;
  }
}
