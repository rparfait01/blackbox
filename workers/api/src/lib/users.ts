/**
 * User identity queries (W8A). A user signs up as a draft (email unverified, no
 * codes), verifies their email by OTP, then finalizes (display mode + lock/duress
 * codes) to become active. Email is the unique handle.
 */

import type { Env } from '../types';

export interface UserRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  phoneVerifiedAt: number | null;
  emailVerifiedAt: number | null;
  displayMode: string | null;
  regionId: string | null;
  lockCodeHash: string | null;
  duressCodeHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Best-effort E.164: keep a leading +, strip everything non-digit. */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^0-9]/g, '');
}

export function getUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    'SELECT id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, createdAt, updatedAt FROM users WHERE id = ?',
  )
    .bind(id)
    .first<UserRow>();
}

export function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    'SELECT id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, createdAt, updatedAt FROM users WHERE email = ?',
  )
    .bind(normalizeEmail(email))
    .first<UserRow>();
}

/** True once the user has finalized (chosen display mode + set a lock code). */
export function isActive(user: UserRow): boolean {
  return user.lockCodeHash != null && user.displayMode != null;
}

export interface CreateDraftResult {
  ok: boolean;
  userId?: string;
  reason?: 'email_taken';
}

/**
 * Create a draft user for a fresh sign-up. If a finalized user already owns the
 * email, refuse. If only an unfinalized draft exists, replace it (re-signup).
 */
export async function createDraftUser(
  env: Env,
  input: { name: string; phone: string; email: string; regionId: string },
): Promise<CreateDraftResult> {
  const email = normalizeEmail(input.email);
  const existing = await getUserByEmail(env, email);
  if (existing && isActive(existing)) {
    return { ok: false, reason: 'email_taken' };
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const statements = [];
  if (existing) {
    statements.push(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(existing.id));
  }
  statements.push(
    env.DB.prepare(
      'INSERT INTO users (id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)',
    ).bind(id, input.name, normalizePhone(input.phone), email, input.regionId, now, now),
  );
  await env.DB.batch(statements);
  return { ok: true, userId: id };
}

export async function markEmailVerified(env: Env, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('UPDATE users SET emailVerifiedAt = ?, updatedAt = ? WHERE id = ?')
    .bind(now, now, userId)
    .run();
}

export async function finalizeUser(
  env: Env,
  userId: string,
  input: { displayMode: 'direct' | 'covert'; lockCodeHash: string; duressCodeHash: string | null },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    'UPDATE users SET displayMode = ?, lockCodeHash = ?, duressCodeHash = ?, updatedAt = ? WHERE id = ?',
  )
    .bind(input.displayMode, input.lockCodeHash, input.duressCodeHash, now, userId)
    .run();
}

/** Patch a subset of user fields (settings edits). */
export async function updateUserFields(
  env: Env,
  userId: string,
  fields: Partial<Pick<UserRow, 'name' | 'displayMode' | 'regionId' | 'lockCodeHash' | 'duressCodeHash'>>,
): Promise<void> {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value as string | null);
  }
  if (sets.length === 0) {
    return;
  }
  const now = Date.now();
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`)
    .bind(...values, now, userId)
    .run();
}

/**
 * True while the user has an active alert (Fix Brief 4 S1). Settings that affect
 * alert integrity (codes, contacts, channels) are locked during an active event
 * so an aggressor can't rewrite them mid-alert and then stand down.
 */
export async function hasActiveEvent(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM events WHERE userId = ? AND status = 'active' LIMIT 1",
  )
    .bind(userId)
    .first<{ x: number }>();
  return row != null;
}

/** Claim pre-existing pilot rows (keyed by userHash) into the new user account. */
export async function claimByUserHash(env: Env, userId: string, userHash: string): Promise<void> {
  if (!userHash) {
    return;
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET userId = ? WHERE userHash = ? AND userId IS NULL').bind(
      userId,
      userHash,
    ),
    env.DB.prepare('UPDATE contacts SET userId = ? WHERE userHash = ? AND userId IS NULL').bind(
      userId,
      userHash,
    ),
  ]);
}
