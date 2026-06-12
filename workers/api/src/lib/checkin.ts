/**
 * Check-in ("I'm OK") — Brief 10. The autonomy counterpart to the alert: a
 * voluntary, NON-emergency reassurance ping. It creates NO event, NO capture, NO
 * coordinator, NO escalation — it just sends a calm message to the chosen
 * recipients (default: guardian) and records the time. Location is included ONLY
 * if the user opted in for this tap.
 */

import { formatLocalClock } from '@blackbox/shared';
import { dispatch } from '../channels/router';
import { audit } from './audit';
import { slotAddress, type SlotKey } from './roles';
import { getUserById } from './users';
import type { Env } from '../types';

async function slotContactId(env: Env, userId: string, slot: SlotKey): Promise<string | null> {
  const addr = slotAddress(slot);
  if (!addr) {
    return null;
  }
  const row = await env.DB.prepare(
    'SELECT id FROM contacts WHERE userId = ? AND role = ? AND ((? IS NULL AND priority IS NULL) OR priority = ?) LIMIT 1',
  )
    .bind(userId, addr.role, addr.priority, addr.priority)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export interface CheckinInput {
  includeLocation: boolean;
  location?: { lat: number; lon: number } | null;
  recipients?: SlotKey[];
  tzOffsetMinutes?: number | null;
}

export async function sendCheckin(
  env: Env,
  userId: string,
  input: CheckinInput,
): Promise<{ ok: boolean; at: number; recipients: number }> {
  const user = await getUserById(env, userId);
  const now = Date.now();
  const tz = input.tzOffsetMinutes ?? null;
  const location = input.includeLocation && input.location ? input.location : null;

  // Record the check-in (the reassurance trail) + the last-check-in pointer.
  const checkinId = `chk-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO checkins (id, userId, createdAt, tzOffsetMinutes, includeLocation, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(checkinId, userId, now, tz, location ? 1 : 0, location?.lat ?? null, location?.lon ?? null),
    env.DB.prepare('UPDATE users SET lastCheckinAt = ? WHERE id = ?').bind(now, userId),
  ]);

  // Default recipient is the guardian; the user may choose contacts too.
  const slots = input.recipients && input.recipients.length > 0 ? input.recipients : (['guardian'] as SlotKey[]);
  const payload = {
    userDisplayName: user?.name ?? 'A BLACK BOX user',
    time: formatLocalClock(now, tz),
    location,
  };

  let delivered = 0;
  for (const slot of slots) {
    const contactId = await slotContactId(env, userId, slot);
    if (!contactId) {
      continue;
    }
    const result = await dispatch(env, contactId, { kind: 'checkin', eventId: checkinId, payload });
    if (result.delivered) {
      delivered += 1;
    }
  }
  await audit(env, checkinId, 'checkin', userId, { recipients: delivered, location: location != null });
  return { ok: true, at: now, recipients: delivered };
}
