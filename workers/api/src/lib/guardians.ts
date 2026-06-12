/**
 * Guardian (support contact) invites (W8A). A user invites one guardian; the
 * guardian accepts via a magic link, verifies a reach channel by OTP, and that
 * channel becomes a priority-1 endpoint on the user's contact. v0 is single
 * guardian; multi-guardian + coordinator logic is W8B.
 */

import type { Env } from '../types';
import { addEndpoint, ensureContactForUser, setPrimaryEndpoint } from './contacts';
import { getUserById } from './users';
import { normalizeEmail, normalizePhone } from './users';

export interface GuardianInviteRow {
  id: string;
  userId: string;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
  relationship: string | null;
  status: string;
  createdAt: number;
  acceptedAt: number | null;
  preferredChannel: string | null;
  channelDestination: string | null;
}

const INVITE_COLS =
  'id, userId, guardianName, guardianPhone, guardianEmail, relationship, status, createdAt, acceptedAt, preferredChannel, channelDestination';

export type PreferredChannel = 'sms' | 'line' | 'email';

/** Normalize a destination for its channel (phone → E.164-ish, email → lowercased). */
export function normalizeDestination(channel: PreferredChannel, destination: string): string {
  if (channel === 'sms') {
    return normalizePhone(destination);
  }
  if (channel === 'email') {
    return normalizeEmail(destination);
  }
  return destination.trim();
}

/**
 * Save (add or edit) the user's guardian with a chosen primary channel +
 * destination, stored as the priority-1 endpoint (Fix Brief 3 contact setup).
 * The user vouches for the destination, so the endpoint is live immediately
 * (status 'accepted'); no acceptance round-trip is required.
 */
export async function saveContact(
  env: Env,
  userId: string,
  input: { name: string; relationship?: string; channel: PreferredChannel; destination: string },
): Promise<void> {
  const dest = normalizeDestination(input.channel, input.destination);
  const id = crypto.randomUUID();
  const email = input.channel === 'email' ? dest : null;
  const phone = input.channel === 'sms' ? dest : null;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM guardian_invites WHERE userId = ?').bind(userId),
    env.DB.prepare(
      'INSERT INTO guardian_invites (id, userId, guardianName, guardianPhone, guardianEmail, relationship, status, createdAt, acceptedAt, preferredChannel, channelDestination) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      id,
      userId,
      input.name,
      phone,
      email,
      input.relationship ?? null,
      'accepted',
      Date.now(),
      Date.now(),
      input.channel,
      dest,
    ),
  ]);
  const user = await getUserById(env, userId);
  await setPrimaryEndpoint(env, userId, user?.name ?? 'BLACK BOX user', input.channel, dest);
}

export async function createInvite(
  env: Env,
  userId: string,
  input: { name: string; phone?: string; email?: string; relationship?: string },
): Promise<string> {
  // One guardian in v0: replace any prior invite for this user.
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM guardian_invites WHERE userId = ?').bind(userId),
    env.DB.prepare(
      'INSERT INTO guardian_invites (id, userId, guardianName, guardianPhone, guardianEmail, relationship, status, createdAt, acceptedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    ).bind(
      id,
      userId,
      input.name,
      input.phone ? normalizePhone(input.phone) : null,
      input.email ? normalizeEmail(input.email) : null,
      input.relationship ?? null,
      'pending',
      Date.now(),
    ),
  ]);
  return id;
}

export function getInvite(env: Env, id: string): Promise<GuardianInviteRow | null> {
  return env.DB.prepare(`SELECT ${INVITE_COLS} FROM guardian_invites WHERE id = ?`)
    .bind(id)
    .first<GuardianInviteRow>();
}

export function getInviteForUser(env: Env, userId: string): Promise<GuardianInviteRow | null> {
  return env.DB.prepare(
    `SELECT ${INVITE_COLS} FROM guardian_invites WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
  )
    .bind(userId)
    .first<GuardianInviteRow>();
}

export async function removeInvite(env: Env, userId: string): Promise<void> {
  const contact = await env.DB.prepare('SELECT id FROM contacts WHERE userId = ?')
    .bind(userId)
    .first<{ id: string }>();
  const statements = [env.DB.prepare('DELETE FROM guardian_invites WHERE userId = ?').bind(userId)];
  if (contact) {
    statements.push(
      env.DB.prepare('DELETE FROM contact_endpoints WHERE contactId = ?').bind(contact.id),
    );
  }
  await env.DB.batch(statements);
}

/**
 * Mark an invite accepted and register the verified channel as a priority-1
 * endpoint on the user's contact. Returns false if the user no longer exists.
 */
export async function acceptInvite(
  env: Env,
  invite: GuardianInviteRow,
  channel: string,
  channelIdentifier: string,
): Promise<boolean> {
  const user = await getUserById(env, invite.userId);
  if (!user) {
    return false;
  }
  // The contact's displayName is the USER's name (the alert subject).
  const contactId = await ensureContactForUser(env, invite.userId, user.name ?? 'BLACK BOX user');
  await addEndpoint(env, contactId, channel, channelIdentifier, 1);
  // Register the guardian's phone as an SMS endpoint too (same priority). SMS is
  // the default primary channel; the dispatcher's channel-rank tie-break sends
  // SMS before email, with email as the fallback (Fix Brief 3 R4 + Twilio).
  if (invite.guardianPhone) {
    await addEndpoint(env, contactId, 'sms', normalizePhone(invite.guardianPhone), 1);
  }
  await env.DB.prepare(
    'UPDATE guardian_invites SET status = ?, acceptedAt = ? WHERE id = ?',
  )
    .bind('accepted', Date.now(), invite.id)
    .run();
  return true;
}
