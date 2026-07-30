/**
 * Check-in ("I'm OK") — Brief 10 + Brief 19. The autonomy counterpart to the
 * alert: a voluntary, NON-emergency reassurance ping to ONE designated contact. It
 * creates NO event, NO capture, NO coordinator, NO escalation — it just sends a
 * calm status message and records the time.
 *
 * Recipient: the PRIMARY contact if deliverable, else an HONEST failure. ONE
 * routing rule, server-side, with no second door.
 *
 * There used to be a per-user override (`users.checkinContactId`, Brief 19): a
 * designated contact took precedence and the primary was only the fallback. That
 * override is retired. Two reasons, in order:
 *
 *   1. It could not express a choice. Contact Consent §0 cut the contact ceiling to
 *      ONE slot (`CONTACT_SLOTS = ['primary']`), so the only contact a user could
 *      designate WAS the primary. The selector offered a decision that had exactly
 *      one outcome.
 *   2. It was a second routing door. Two ways to answer "who gets the check-in" is
 *      the same shape as the dual trigger paths and the fourth report door this
 *      codebase has already had to collapse — a divergence waiting to happen, where
 *      the stale one points at a contact the user thinks they removed.
 *
 * Proven before removal: 0 of 2 production accounts had a non-null
 * checkinContactId, so no live routing changed. 0045 drops the column so the door
 * cannot be reopened by a future reader.
 *
 * It is NEVER the guardian, and it NEVER reports success with zero recipients.
 * Location is always captured on tap (Brief 17 §1) — no opt-in flag.
 */

import { formatLocalClock } from '@blackbox/shared';
import { dispatch } from '../channels/router';
import { isChannelDeliverable } from '../channels/router';
import { audit } from './audit';
import { consentGateEnforced } from './consent';
import { getUserById } from './users';
import type { Env } from '../types';

/** A contact is a viable check-in target only if at least one of its endpoints can
 *  actually deliver in this deployment (mirrors dispatch trying each endpoint). */
async function contactDeliverable(env: Env, contactId: string): Promise<boolean> {
  const { results } = await env.DB.prepare('SELECT channel FROM contact_endpoints WHERE contactId = ?')
    .bind(contactId)
    .all<{ channel: string }>();
  return (results ?? []).some((e) => isChannelDeliverable(env, e.channel));
}

/**
 * Resolve the single check-in recipient: the PRIMARY contact, or none. Only ever a
 * `contact` role (never guardian/emergency), and only if it can actually be
 * reached. Returns the contact id or null.
 *
 * This is the ONLY function that answers "who receives a check-in". There is no
 * override, no per-user column, and no caller-supplied recipient — so the answer
 * cannot differ between the UI's claim and the dispatcher's behaviour.
 */
async function resolveCheckinContact(env: Env, userId: string): Promise<string | null> {
  // CONSENT-GATED (§4, behind the flag): once armed, a check-in reaches a recipient
  // only if that contact has CONFIRMED the role — same rule as an alert. A pending
  // contact is not a silent success; the check-in resolves to null and the UI
  // reflects "no confirmed recipient" rather than reporting a delivery that never
  // happened.
  const gate = consentGateEnforced(env) ? "AND status = 'confirmed'" : '';
  const primary = await env.DB.prepare(
    `SELECT id FROM contacts WHERE userId = ? AND role = 'contact' AND priority = 1 ${gate} LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>();
  if (primary && (await contactDeliverable(env, primary.id))) {
    return primary.id;
  }
  return null;
}

export interface CheckinInput {
  location?: { lat: number; lon: number } | null;
  tzOffsetMinutes?: number | null;
}

export interface CheckinResult {
  ok: boolean;
  id: string;
  at: number;
  recipients: number;
  /** Present only on failure, so the client can show an honest, specific reason. */
  reason?: 'no_recipient' | 'delivery_failed';
}

export async function sendCheckin(env: Env, userId: string, input: CheckinInput): Promise<CheckinResult> {
  const user = await getUserById(env, userId);
  const now = Date.now();
  const tz = input.tzOffsetMinutes ?? null;
  const location = input.location ?? null;

  // Record the check-in (the reassurance trail) + the last-check-in pointer. The
  // record is written regardless of delivery; the user-facing result reflects
  // whether the designated contact was actually reached (no silent success).
  const checkinId = `chk-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO checkins (id, userId, createdAt, tzOffsetMinutes, includeLocation, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(checkinId, userId, now, tz, location ? 1 : 0, location?.lat ?? null, location?.lon ?? null),
    env.DB.prepare('UPDATE users SET lastCheckinAt = ? WHERE id = ?').bind(now, userId),
  ]);

  const contactId = await resolveCheckinContact(env, userId);
  if (!contactId) {
    // No primary contact that can be reached → honest failure. NEVER ok:true with
    // zero recipients.
    await audit(env, checkinId, 'checkin', userId, { recipients: 0, reason: 'no_recipient', location: location != null });
    return { ok: false, id: checkinId, at: now, recipients: 0, reason: 'no_recipient' };
  }

  const payload = {
    userDisplayName: user?.name ?? 'A BLACK BOX user',
    time: formatLocalClock(now, tz),
    location,
  };
  const result = await dispatch(env, contactId, { kind: 'checkin', eventId: checkinId, payload });
  const delivered = result.delivered ? 1 : 0;
  await audit(env, checkinId, 'checkin', userId, { recipients: delivered, location: location != null });
  return result.delivered
    ? { ok: true, id: checkinId, at: now, recipients: 1 }
    : { ok: false, id: checkinId, at: now, recipients: 0, reason: 'delivery_failed' };
}
