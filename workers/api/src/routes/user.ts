/**
 * User-scoped profile + settings (W8A). All session-protected. Profile name /
 * email / phone editing is read-only in v0 (email/phone changes are deferred);
 * display mode, region, and the lock/duress codes are editable.
 */

import { Hono } from 'hono';
import { requireSession } from '../auth';
import { hashSecret, verifySecret } from '../lib/crypto';
import { getInviteForUser, normalizeDestination, type PreferredChannel } from '../lib/guardians';
import { deleteAccount, getUserById, hasActiveEvent, setGuardianEnabled, updateUserFields } from '../lib/users';
import {
  guardianLoad,
  listSlots,
  removeSlot,
  upsertSlot,
  type SlotKey,
} from '../lib/roles';
import { sendCheckin } from '../lib/checkin';
import { isChannelDeliverable } from '../channels/router';
import type { Env, Vars } from '../types';

export const userRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

userRoutes.use('*', requireSession);

/** 423 Locked if the user has an active alert (Fix Brief 4 S1). */
async function lockedDuringAlert(c: { env: Env; get: (k: 'userId') => string }): Promise<boolean> {
  return hasActiveEvent(c.env, c.get('userId'));
}

function isFourDigits(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}$/.test(value);
}

userRoutes.get('/', async (c) => {
  const user = await getUserById(c.env, c.get('userId'));
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  const region = user.regionId
    ? await c.env.DB.prepare(
        'SELECT id, name, defaultEmergencyNumber, defaultLanguage FROM regions WHERE id = ?',
      )
        .bind(user.regionId)
        .first<{ id: string; name: string; defaultEmergencyNumber: string; defaultLanguage: string }>()
    : null;
  const invite = await getInviteForUser(c.env, user.id);
  return c.json(
    {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        displayMode: user.displayMode,
        regionId: user.regionId,
        nationality: user.nationality,
        hasDuressCode: user.duressCodeHash != null,
      },
      region,
      guardian: invite
        ? {
            name: invite.guardianName,
            relationship: invite.relationship,
            status: invite.status,
            channel: invite.preferredChannel,
            destination: invite.channelDestination,
          }
        : null,
    },
    200,
  );
});

userRoutes.post('/display-mode', async (c) => {
  const body = await c.req.json<{ displayMode?: string }>().catch(() => ({}) as Record<string, string>);
  if (body.displayMode !== 'direct' && body.displayMode !== 'covert') {
    return c.json({ error: 'displayMode must be direct or covert' }, 400);
  }
  await updateUserFields(c.env, c.get('userId'), { displayMode: body.displayMode });
  return c.json({ ok: true, displayMode: body.displayMode }, 200);
});

userRoutes.post('/region', async (c) => {
  const body = await c.req.json<{ regionId?: string }>().catch(() => ({}) as Record<string, string>);
  if (!body.regionId) {
    return c.json({ error: 'regionId required' }, 400);
  }
  await updateUserFields(c.env, c.get('userId'), { regionId: body.regionId });
  return c.json({ ok: true }, 200);
});

userRoutes.post('/lock-code', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ oldCode?: string; newCode?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!isFourDigits(body.newCode)) {
    return c.json({ error: 'newCode must be 4 digits' }, 400);
  }
  const user = await getUserById(c.env, c.get('userId'));
  if (!user?.lockCodeHash || !body.oldCode || !(await verifySecret(body.oldCode, user.lockCodeHash))) {
    return c.json({ error: 'old code incorrect' }, 403);
  }
  await updateUserFields(c.env, user.id, { lockCodeHash: await hashSecret(body.newCode) });
  return c.json({ ok: true }, 200);
});

// --- Roles: 3 contacts + 1 guardian (Brief 9 / Brief 8 contact tabs) ---
const VALID_SLOTS: SlotKey[] = ['primary', 'secondary', 'tertiary', 'guardian', 'emergency'];

userRoutes.get('/contacts', async (c) => {
  const userId = c.get('userId');
  const user = await getUserById(c.env, userId);
  const slots = await listSlots(c.env, userId);
  const guardianSlot = slots.find((s) => s.slot === 'guardian');
  const othersLoad =
    guardianSlot?.destination != null
      ? await guardianLoad(c.env, guardianSlot.destination, userId)
      : 0;
  return c.json(
    {
      slots,
      guardianEnabled: (user?.guardianEnabled ?? 1) === 1,
      // Surface the guardian's load so the user can judge reliability (Brief 9 caps).
      guardianAlsoFailsafeFor: othersLoad,
    },
    200,
  );
});

userRoutes.post('/contacts/:slot', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const slot = c.req.param('slot') as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  const body = await c.req
    .json<{ contactName?: string; channel?: string; destination?: string }>()
    .catch(() => ({}) as Record<string, string>);
  const channel = body.channel as PreferredChannel | undefined;
  if (!body.contactName?.trim() || !body.destination?.trim()) {
    return c.json({ error: 'name and destination are required' }, 400);
  }
  if (channel !== 'sms' && channel !== 'line' && channel !== 'email') {
    return c.json({ error: 'channel must be sms, line or email' }, 400);
  }
  // Never accept a contact on a channel that cannot deliver in this deployment —
  // it would fail silently at alert time. Refuse with a clear, surfaced reason.
  if (!isChannelDeliverable(c.env, channel)) {
    return c.json(
      {
        error: 'channel_not_available',
        channel,
        message: `${channel.toUpperCase()} is not available yet — this contact would not be reached. Use Email.`,
      },
      400,
    );
  }
  const user = await getUserById(c.env, c.get('userId'));
  await upsertSlot(c.env, c.get('userId'), slot, {
    contactName: body.contactName.trim(),
    userDisplayName: user?.name ?? 'BLACK BOX user',
    channel,
    destination: normalizeDestination(channel, body.destination.trim()),
  });
  return c.json({ ok: true }, 200);
});

userRoutes.delete('/contacts/:slot', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const slot = c.req.param('slot') as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  await removeSlot(c.env, c.get('userId'), slot);
  return c.json({ ok: true }, 200);
});

// Delete account (Brief 13 B17). Behind a client confirmation; blocked during an
// active alert so an aggressor can't wipe the account to kill a live event.
userRoutes.delete('/account', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  await deleteAccount(c.env, c.get('userId'));
  return c.json({ ok: true }, 200);
});

// Check-in ("I'm OK") — Brief 10. NON-emergency: no event, no capture. NOT
// locked during an alert (it's a separate, harmless reassurance ping).
userRoutes.post('/checkin', async (c) => {
  const body = await c.req
    .json<{ includeLocation?: boolean; location?: { lat: number; lon: number } | null; recipients?: string[]; tzOffsetMinutes?: number }>()
    .catch(() => ({}) as Record<string, never>);
  const recipients = Array.isArray(body.recipients)
    ? (body.recipients.filter((r) => ['primary', 'secondary', 'tertiary', 'guardian'].includes(r)) as SlotKey[])
    : undefined;
  const result = await sendCheckin(c.env, c.get('userId'), {
    includeLocation: body.includeLocation === true,
    location: body.includeLocation === true ? body.location ?? null : null,
    recipients,
    tzOffsetMinutes: typeof body.tzOffsetMinutes === 'number' ? body.tzOffsetMinutes : null,
  });
  return c.json(result, 200);
});

userRoutes.post('/guardian-enabled', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
  await setGuardianEnabled(c.env, c.get('userId'), body.enabled === true);
  return c.json({ ok: true, enabled: body.enabled === true }, 200);
});

userRoutes.post('/duress-code', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ lockCode?: string; newDuressCode?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!isFourDigits(body.newDuressCode)) {
    return c.json({ error: 'newDuressCode must be 4 digits' }, 400);
  }
  const user = await getUserById(c.env, c.get('userId'));
  if (!user?.lockCodeHash || !body.lockCode || !(await verifySecret(body.lockCode, user.lockCodeHash))) {
    return c.json({ error: 'lock code incorrect' }, 403);
  }
  await updateUserFields(c.env, user.id, { duressCodeHash: await hashSecret(body.newDuressCode) });
  return c.json({ ok: true }, 200);
});
