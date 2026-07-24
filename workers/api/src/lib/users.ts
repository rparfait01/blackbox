/**
 * User identity queries (W8A). A user signs up as a draft (email unverified, no
 * codes), verifies their email by OTP, then finalizes (display mode + lock/duress
 * codes) to become active. Email is the unique handle.
 */

import type { Env } from '../types';
import { verifySecret } from './crypto';

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
  passwordHash: string | null;
  guardianEnabled: number;
  nationality: string | null;
  /** The contact designated as the check-in recipient (Brief 19). NULL → default
   *  to the primary contact at resolve time. Never the guardian. */
  checkinContactId: string | null;
  /** Entitlement (Brief 28). 'unactivated' | 'activated'. One-way: once 'activated'
   *  it is NEVER set back — permanent, offline-durable, never re-checked. Gates the
   *  ARM affordance only; the trigger path never reads it. */
  entitlement: string;
  /** How entitlement was granted: 'purchase_web' | 'purchase_ios' | 'org_code' |
   *  'operator_grant'. NULL while unactivated. An org_code source never renders price. */
  entitlementSource: string | null;
  /** When entitlement flipped to 'activated'. NULL while unactivated. */
  activatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const USER_COLS =
  'id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, passwordHash, guardianEnabled, nationality, checkinContactId, entitlement, entitlement_source AS entitlementSource, activatedAt, createdAt, updatedAt';

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
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

export function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<UserRow>();
}

/** True once the user has finalized (chosen a display mode). The closure pin is
 *  retired (Brief 16 §1) — closure is gesture-only — so finalization no longer
 *  involves a lock code. */
export function isActive(user: UserRow): boolean {
  return user.displayMode != null;
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
  input: {
    name: string;
    phone: string;
    email: string;
    regionId: string;
    nationality?: string | null;
    passwordHash?: string | null;
  },
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
    // cascadeIntervalSeconds is set to 10 explicitly (the table default predates
    // the 10s cascade spec — Brief 11/17) so new accounts get the correct
    // T+0/+10/+20/+30/+40 windows without depending on the column default.
    env.DB.prepare(
      'INSERT INTO users (id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, passwordHash, nationality, cascadeIntervalSeconds, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, 10, ?, ?)',
    ).bind(
      id,
      input.name,
      normalizePhone(input.phone),
      email,
      input.regionId,
      input.passwordHash ?? null,
      input.nationality ?? null,
      now,
      now,
    ),
  );
  await env.DB.batch(statements);
  return { ok: true, userId: id };
}

/**
 * Verify a login credential (Brief 19 §6). Login is PASSWORD ONLY. The closure pin
 * (lockCodeHash) is a closure-only secret and MUST NOT authenticate login — the
 * legacy pin-as-password fallback is retired so a 3-digit closure pin can never be
 * used to sign in. A password-less legacy account recovers via Forgot Password
 * (§1), never via its pin.
 */
export async function verifyLoginCredential(user: UserRow, credential: string): Promise<boolean> {
  if (!credential || !user.passwordHash) {
    return false;
  }
  return verifySecret(credential, user.passwordHash);
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
  input: { displayMode: 'direct' | 'covert' },
): Promise<void> {
  const now = Date.now();
  // Brief 16 §1: no lock code is set at finalize — closure is gesture-only.
  await env.DB.prepare('UPDATE users SET displayMode = ?, updatedAt = ? WHERE id = ?')
    .bind(input.displayMode, now, userId)
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
 * Designate the check-in recipient (Brief 19). Stores the chosen contact row id;
 * passing null clears it back to the primary-contact default. Validation that the
 * id is one of the user's own `contact` rows lives at the route, so this stays a
 * plain setter mirroring setGuardianEnabled.
 */
export async function setCheckinContact(env: Env, userId: string, contactId: string | null): Promise<void> {
  await env.DB.prepare('UPDATE users SET checkinContactId = ?, updatedAt = ? WHERE id = ?')
    .bind(contactId, Date.now(), userId)
    .run();
}

/** Guardian on/off toggle (Brief 9). Locked during an active alert by the route. */
export async function setGuardianEnabled(env: Env, userId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare('UPDATE users SET guardianEnabled = ?, updatedAt = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, Date.now(), userId)
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

/**
 * Permanently delete a user account (Brief 13 B17). Wipes the identity row, all
 * support-role contacts + their endpoints, and the guardian invite. After this
 * the email is free to sign up again and the old account can never log back in
 * (the users row is gone, so getUserByEmail returns null). Past evidence/custody
 * records are intentionally retained — they are append-only chain-of-custody, not
 * account data, and keyed independently.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  if (!userId) {
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM contact_endpoints WHERE contactId IN (SELECT id FROM contacts WHERE userId = ?)',
    ).bind(userId),
    env.DB.prepare('DELETE FROM contacts WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM guardian_invites WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
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
