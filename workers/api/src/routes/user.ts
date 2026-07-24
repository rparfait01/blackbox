/**
 * User-scoped profile + settings (W8A). All session-protected. Profile name /
 * email / phone editing is read-only in v0 (email/phone changes are deferred);
 * display mode, region, and the lock/duress codes are editable.
 */

import { Hono } from 'hono';
import { requireSession } from '../auth';
import { destinationProblem, getInviteForUser, normalizeDestination, type PreferredChannel } from '../lib/guardians';
import { pairingStatus, startLinePairing } from '../lib/line-pairing';
import { deleteAccount, getUserById, hasActiveEvent, setCheckinContact, setGuardianEnabled, updateUserFields } from '../lib/users';
import {
  guardianLoad,
  hasDeliverableRecipient,
  listSlots,
  removeSlot,
  upsertSlot,
  type SlotKey,
} from '../lib/roles';
import { sendCheckin } from '../lib/checkin';
import { isChannelDeliverable } from '../channels/router';
import { sendConfirmationAsk } from '../lib/consent';
import { leaveOrg, redeemCode } from '../lib/enrollment';
import { normalizeSubmission, submitTally } from '../lib/tally';
import { getAccountKeys, getRecoveryKey, getSurvivorCaptureEnvelope, setRecoveryKey, setUserPubkey } from '../lib/zk-custody';
import { audit } from '../lib/audit';
import type { Env, Vars } from '../types';

export const userRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

userRoutes.use('*', requireSession);

/** 423 Locked if the user has an active alert (Fix Brief 4 S1). */
async function lockedDuringAlert(c: { env: Env; get: (k: 'userId') => string }): Promise<boolean> {
  return hasActiveEvent(c.env, c.get('userId'));
}

// Brief 23 §3 — the SURVIVOR's own enrollment controls (their account stays theirs).
// Redeeming a code is the explicit, consented individual→org migration path; leaving
// is the reversal. Both are account changes, so both respect the live-alert lock like
// contact edits and delete. Past events keep their stamped org — history preserved.
userRoutes.post('/org/redeem', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const code = (body.code ?? '').trim();
  if (!code) {
    return c.json({ error: 'code_required' }, 400);
  }
  const res = await redeemCode(c.env, code, c.get('userId'));
  if (!res.ok) {
    return c.json({ error: res.reason }, 400);
  }
  return c.json({ ok: true, orgId: res.orgId, role: res.role }, 200);
});

userRoutes.post('/org/leave', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const res = await leaveOrg(c.env, c.get('userId'));
  if (!res.ok) {
    // Blocked: you are the second-to-last admin (§0/§6 — the org must keep two).
    return c.json({ error: res.reason, message: 'Your organisation must keep at least two admins. Add another admin before leaving.' }, 409);
  }
  return c.json({ ok: true, left: res.left }, 200);
});

// Brief 26 — zero-knowledge custody key material (dormant until the flag is armed). The
// survivor publishes ONLY their public key; the private half never leaves the device.
// A capture client fetches the keys it must wrap a data key to (its own + the org's).
userRoutes.post('/pubkey', async (c) => {
  const body = await c.req.json<{ pubkey?: string }>().catch(() => ({}) as { pubkey?: string });
  const pubkey = (body.pubkey ?? '').trim();
  if (!pubkey) {
    return c.json({ error: 'pubkey_required' }, 400);
  }
  await setUserPubkey(c.env, c.get('userId'), pubkey);
  return c.json({ ok: true }, 200);
});

userRoutes.get('/keys', async (c) => {
  return c.json(await getAccountKeys(c.env, c.get('userId')), 200);
});

// Decision A — the survivor's recovery-wrapped private key (opaque to the server). Stored
// so a new device + the recovery code can restore it; the server never sees the code or
// the private key in clear.
userRoutes.post('/recovery-key', async (c) => {
  const body = await c.req.json<{ wrapped?: string }>().catch(() => ({}) as { wrapped?: string });
  const wrapped = (body.wrapped ?? '').trim();
  if (!wrapped) {
    return c.json({ error: 'wrapped_required' }, 400);
  }
  await setRecoveryKey(c.env, c.get('userId'), wrapped);
  return c.json({ ok: true }, 200);
});

userRoutes.get('/recovery-key', async (c) => {
  return c.json({ wrapped: await getRecoveryKey(c.env, c.get('userId')) }, 200);
});

// Brief 26 state 6 (Review) — the OWNING survivor fetches their capture's wrapped DEK +
// commitments to decrypt it client-side. Fetching the key is the audited decrypt point
// (the invariant: every decrypt is logged — who, what, when); the actual decrypt happens
// on the survivor's device, never here. Ownership is enforced in the helper.
userRoutes.get('/events/:id/envelope', async (c) => {
  const eventId = c.req.param('id');
  const envelope = await getSurvivorCaptureEnvelope(c.env, c.get('userId'), eventId);
  if (!envelope) {
    return c.json({ envelope: null }, 200);
  }
  await audit(c.env, eventId, 'decrypt_review', c.get('userId'), { via: 'survivor' });
  return c.json({ envelope }, 200);
});

// Brief 25 — Anonymous Incident Tally. The session authenticates the SENDER (for the
// per-account rate limit ONLY); the survivor's identity is NEVER written to the stored
// record (see lib/tally.ts). Live-alert-locked (§7): a calm, deliberate act, never
// taken under duress. The submission NEVER reads or derives from capture/event data —
// only the four closed-vocabulary answers reach the severed store.
userRoutes.post('/tally', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ kind?: unknown; roughlyWhen?: unknown; regionId?: unknown; reportedOfficial?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const closed = normalizeSubmission(body);
  // regionId is a jurisdiction label: accept ONLY a known region id (never a finer or
  // arbitrary string), else null. Coarse-by-construction.
  let regionId: string | null = null;
  if (typeof body.regionId === 'string' && body.regionId) {
    const known = await c.env.DB.prepare('SELECT id FROM regions WHERE id = ?')
      .bind(body.regionId)
      .first<{ id: string }>();
    regionId = known?.id ?? null;
  }
  const res = await submitTally(c.env, c.get('userId'), { ...closed, regionId }, Date.now());
  if (!res.ok) {
    // Honest status (§4): never a silent discard — the survivor must never believe
    // something was counted when it wasn't.
    return c.json({ error: 'rate_limited', used: res.used, limit: res.limit }, 429);
  }
  return c.json({ ok: true }, 201);
});

/**
 * §3 "Track" — what the account can see about ITSELF: how it is protected, who it
 * can reach, and when it last checked in. Self-view only.
 *
 * `lastCheckinAt` is read with its own query because USER_COLS deliberately does
 * not select it.
 */
async function accountState(
  env: Env,
  userId: string,
): Promise<{
  passkeys: number;
  hasRecoveryCode: boolean;
  contactsConfigured: number;
  lastCheckinAt: number | null;
}> {
  const [passkeys, recovery, slots, checkin] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE userId = ?')
      .bind(userId)
      .first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE userId = ? AND consumedAt IS NULL')
      .bind(userId)
      .first<{ n: number }>(),
    listSlots(env, userId),
    env.DB.prepare('SELECT lastCheckinAt FROM users WHERE id = ?')
      .bind(userId)
      .first<{ lastCheckinAt: number | null }>(),
  ]);
  return {
    passkeys: passkeys?.n ?? 0,
    hasRecoveryCode: (recovery?.n ?? 0) > 0,
    // The recipients an alert would actually fan out to — 'emergency' is the
    // unclaimed-tail fallback, not someone the survivor configured to be told.
    contactsConfigured: slots.filter((s) => s.filled && s.slot !== 'emergency').length,
    lastCheckinAt: checkin?.lastCheckinAt ?? null,
  };
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
      // Server-truth live-alert flag (Brief 20 §1). The client gates settings entry
      // and refuses sign-out on THIS, not just its local session — so a device that
      // lost its local session can never open settings or sign out of a live alert.
      activeEvent: await hasActiveEvent(c.env, user.id),
      // §3 "Track": the account's own state, for the SELF-VIEW only. Strictly this
      // user's own row — there is no cross-account visibility anywhere here, and
      // Tenancy must not quietly turn this into one.
      account: await accountState(c.env, user.id),
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


// --- Roles: contact slots + guardian ---
// Contact Consent §0 reduced the survivor-facing ceiling to ONE contact + guardian
// (people in these circumstances have deliberately narrowed networks; more slots
// does not serve them). That cap is enforced in the UI — the add screen only ever
// offers primary + guardian. The SERVER stays permissive on secondary/tertiary on
// purpose: the staggered activation cascade (primary→secondary→tertiary→guardian→
// emergency, Brief 11/17) is a load-bearing safety mechanism whose multi-step DO
// alarm timing is regression-tested here, and hard-removing the slots server-side
// would degrade that coverage for no safety gain — a UI that never offers a slot is
// the cap that matters. No pilot account has ever held more than one contact.
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
      // Armability: true only when at least one recipient could ACTUALLY be
      // reached on activation. The client gates the activate affordance on this so
      // the user can never arm into the notify-no-one deadlock; the server also
      // enforces it at POST /v1/events.
      armable: await hasDeliverableRecipient(c.env, userId),
      // Brief 19: the designated check-in recipient (null → the primary contact is
      // used by default). Lets the UI mark which contact holds the check-in.
      checkinContactId: user?.checkinContactId ?? null,
      // Which channels can ACTUALLY deliver right now — server truth, derived from
      // the same isChannelDeliverable the dispatcher and the save-guard use. The UI
      // renders from THIS rather than a hardcoded list, so the day Twilio is
      // provisioned SMS appears everywhere on its own and email disappears the day
      // it is retired — no client release, no list to forget to update. Channels are
      // inputs to one dispatcher; the UI has to reflect that or it drifts.
      deliverableChannels: (['sms', 'line', 'email'] as const).filter((ch) =>
        isChannelDeliverable(c.env, ch),
      ),
      // LINE is captured ONLY by QR (Brief 18) — it can never be a typed address,
      // which the UI needs to know to offer a usable backup channel.
      typeableChannels: (['sms', 'email'] as const).filter((ch) => isChannelDeliverable(c.env, ch)),
    },
    200,
  );
});

// Designate the check-in recipient (Brief 19). Exactly one contact holds it; it
// must be one of the user's own `contact` rows (never the guardian). Passing null
// clears back to the primary-contact default. Not locked during an alert —
// check-in is a dormant-only reassurance feature and never touches the event.
userRoutes.post('/checkin-contact', async (c) => {
  const body = await c.req.json<{ contactId?: string | null }>().catch(() => ({}) as { contactId?: string | null });
  const contactId = typeof body.contactId === 'string' && body.contactId.trim() ? body.contactId.trim() : null;
  if (contactId) {
    const owned = await c.env.DB.prepare(
      "SELECT id FROM contacts WHERE id = ? AND userId = ? AND role = 'contact'",
    )
      .bind(contactId, c.get('userId'))
      .first<{ id: string }>();
    if (!owned) {
      return c.json({ error: 'invalid_contact', message: 'Choose one of your own contacts.' }, 400);
    }
  }
  await setCheckinContact(c.env, c.get('userId'), contactId);
  return c.json({ ok: true, checkinContactId: contactId }, 200);
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
    .json<{
      contactName?: string;
      channel?: string;
      destination?: string;
      fallbackChannel?: string;
      fallbackDestination?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);
  const channel = body.channel as PreferredChannel | undefined;
  if (!body.contactName?.trim() || !body.destination?.trim()) {
    return c.json({ error: 'name and destination are required' }, 400);
  }
  if (channel !== 'sms' && channel !== 'line' && channel !== 'email') {
    return c.json({ error: 'channel must be sms, line or email' }, 400);
  }
  // LINE can NEVER be entered by hand (Brief 18): a userId is captured only via the
  // QR-connect pairing, which writes the slot itself. Refuse a manual LINE save so
  // no one ever types/looks up a LINE id.
  if (channel === 'line') {
    return c.json(
      {
        error: 'line_requires_pairing',
        channel,
        message: 'Connect LINE with the QR code — a LINE contact is captured by scanning, never typed.',
      },
      400,
    );
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
  // Reject a malformed destination (e.g. a LINE handle that is not a userId) up
  // front — it would 400 at the provider and never deliver. Never store it.
  const destProblem = destinationProblem(channel, body.destination.trim());
  if (destProblem) {
    return c.json({ error: 'invalid_destination', channel, message: destProblem }, 400);
  }
  // §2: the optional FALLBACK channel — what the dispatcher reaches for when the
  // preferred one fails. Validated to the same standard as the preferred channel:
  // a fallback that cannot deliver is not a fallback, it is a second silent
  // failure, so it is refused rather than stored and discovered mid-alert.
  let fallbackChannel: PreferredChannel | null = null;
  let fallbackDestination: string | null = null;
  if (body.fallbackChannel && body.fallbackDestination?.trim()) {
    const fb = body.fallbackChannel as PreferredChannel;
    if (fb !== 'sms' && fb !== 'line' && fb !== 'email') {
      return c.json({ error: 'invalid_fallback_channel', message: 'Fallback must be sms, line or email.' }, 400);
    }
    if (fb === 'line') {
      // Same rule as the preferred channel — LINE is only ever captured by QR.
      return c.json(
        { error: 'line_requires_pairing', channel: fb, message: 'Connect LINE with the QR code — never typed.' },
        400,
      );
    }
    if (fb === channel) {
      return c.json(
        {
          error: 'fallback_same_channel',
          message: 'The backup must be a different channel — the same one twice is the same failure twice.',
        },
        400,
      );
    }
    if (!isChannelDeliverable(c.env, fb)) {
      return c.json(
        {
          error: 'channel_not_available',
          channel: fb,
          message: `${fb.toUpperCase()} is not available yet — it could not be a backup.`,
        },
        400,
      );
    }
    const fbProblem = destinationProblem(fb, body.fallbackDestination.trim());
    if (fbProblem) {
      return c.json({ error: 'invalid_destination', channel: fb, message: fbProblem }, 400);
    }
    fallbackChannel = fb;
    fallbackDestination = normalizeDestination(fb, body.fallbackDestination.trim());
  }

  const user = await getUserById(c.env, c.get('userId'));
  const preferredDestination = normalizeDestination(channel, body.destination.trim());
  const upsert = await upsertSlot(c.env, c.get('userId'), slot, {
    contactName: body.contactName.trim(),
    userDisplayName: user?.name ?? 'BLACK BOX user',
    channel,
    destination: preferredDestination,
    fallbackChannel,
    fallbackDestination,
  });
  // §1: a newly-pending SMS contact receives ONE confirmation ask — the only
  // message they get until they reply. Off the response path (waitUntil): the save
  // already succeeded, and an SMS hiccup must not fail it. The survivor sees the
  // Pending state regardless of whether the send lands.
  if (upsert.confirmationNeeded) {
    const survivorName = user?.name ?? 'Someone';
    c.executionCtx.waitUntil(
      sendConfirmationAsk(c.env, preferredDestination, survivorName).then((sent) =>
        audit(c.env, null, sent ? 'consent.ask_sent' : 'consent.ask_failed', c.get('userId'), { slot }),
      ),
    );
  }
  return c.json({ ok: true, status: upsert.status }, 200);
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

// QR-connect LINE pairing (Brief 18). Start a pairing for a slot → returns a deep
// link + QR carrying a one-tap prefilled token; the contact scans/sends it in LINE
// and the webhook binds their userId to the slot. No LINE id is ever typed.
userRoutes.post('/line-pairing/start', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ slot?: string; contactName?: string }>()
    .catch(() => ({}) as { slot?: string; contactName?: string });
  const slot = body.slot as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  if (!body.contactName?.trim()) {
    return c.json({ error: 'name required', message: 'Add a name first.' }, 400);
  }
  if (!isChannelDeliverable(c.env, 'line')) {
    return c.json({ error: 'channel_not_available', channel: 'line', message: 'LINE is not available yet.' }, 400);
  }
  const started = await startLinePairing(c.env, c.get('userId'), slot, body.contactName.trim());
  return c.json(started, 200);
});

// Poll a pairing's status (never returns the captured userId).
userRoutes.get('/line-pairing/status', async (c) => {
  const nonce = c.req.query('nonce') ?? '';
  const status = await pairingStatus(c.env, c.get('userId'), nonce);
  if (!status) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(status, 200);
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
    .json<{ location?: { lat: number; lon: number } | null; tzOffsetMinutes?: number }>()
    .catch(() => ({}) as Record<string, never>);
  // Location is ALWAYS captured on tap (Brief 17 §1) — no opt-in flag. Carried
  // when the client resolved a fix; null when it couldn't.
  const location =
    body.location && typeof body.location.lat === 'number' && typeof body.location.lon === 'number'
      ? { lat: body.location.lat, lon: body.location.lon }
      : null;
  const result = await sendCheckin(c.env, c.get('userId'), {
    location,
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

