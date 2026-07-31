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
  // NOTE: there is no `checkinContactId`. Check-in routing is primary-only and lives
  // entirely in resolveCheckinContact() (lib/checkin.ts); 0045 dropped the column.
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
  'id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, passwordHash, guardianEnabled, nationality, entitlement, entitlement_source AS entitlementSource, activatedAt, createdAt, updatedAt';

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
export interface DeleteAccountResult {
  /** True when nothing was deleted — a preview of what WOULD go. */
  dryRun: boolean;
  events: number;
  chunks: number;
  /** R2 objects actually removed (0 on a dry run). */
  r2Deleted: number;
  contacts: number;
  deleted: boolean;
}

/**
 * Delete an account and EVERYTHING it owns (Brief 33 §4).
 *
 * ROOT CAUSE THIS FIXES: the previous implementation deleted contacts, endpoints,
 * guardian invites and the user row — and nothing else. It left the account's EVENTS
 * behind, and with them every chunks_index row and every R2 capture object. That is
 * precisely how ~10,700 orphaned recordings accumulated: a survivor "deleted their
 * account" and their audio stayed in storage indefinitely, unreachable and unattributable.
 * Deleting the index without first deleting the bytes also makes the orphans permanently
 * un-enumerable, because the index is the only thing that names them.
 *
 * SO THE ORDER IS LOAD-BEARING: read the R2 keys from chunks_index FIRST, delete the R2
 * objects, and only then delete the rows. Reversing it strands the audio forever — which
 * is exactly what happened before.
 *
 * DRY-RUN BY DEFAULT. `confirm` must be explicitly true. A malformed or empty request
 * previews and deletes nothing — an account deletion is irreversible and must never be
 * triggered by a mistake.
 */
export async function deleteAccount(
  env: Env,
  userId: string,
  opts: { confirm?: boolean } = {},
): Promise<DeleteAccountResult> {
  const empty: DeleteAccountResult = {
    dryRun: opts.confirm !== true,
    events: 0,
    chunks: 0,
    r2Deleted: 0,
    contacts: 0,
    deleted: false,
  };
  if (!userId) {
    return empty;
  }

  // Enumerate BEFORE deleting anything — this is the only moment the account's R2
  // objects can still be named.
  const { results: eventRows } = await env.DB.prepare('SELECT id FROM events WHERE userId = ?')
    .bind(userId)
    .all<{ id: string }>();
  const eventIds = (eventRows ?? []).map((r) => r.id);

  const { results: chunkRows } = await env.DB.prepare(
    'SELECT r2Key FROM chunks_index WHERE eventId IN (SELECT id FROM events WHERE userId = ?)',
  )
    .bind(userId)
    .all<{ r2Key: string }>();
  const r2Keys = (chunkRows ?? []).map((r) => r.r2Key);

  const { results: contactRows } = await env.DB.prepare('SELECT id FROM contacts WHERE userId = ?')
    .bind(userId)
    .all<{ id: string }>();

  const preview: DeleteAccountResult = {
    dryRun: opts.confirm !== true,
    events: eventIds.length,
    chunks: r2Keys.length,
    r2Deleted: 0,
    contacts: (contactRows ?? []).length,
    deleted: false,
  };
  if (opts.confirm !== true) {
    return preview;
  }

  // 1. The BYTES first. R2 accepts up to 1000 keys per bulk delete.
  let r2Deleted = 0;
  if (env.MEDIA && r2Keys.length > 0) {
    for (let i = 0; i < r2Keys.length; i += 1000) {
      const batch = r2Keys.slice(i, i + 1000);
      await env.MEDIA.delete(batch);
      r2Deleted += batch.length;
    }
  }

  // 2. Then every row keyed to those events, then the events, then the account. Scoped
  //    by subquery so an account with zero events deletes nothing extra.
  const byEvent = (table: string) =>
    env.DB.prepare(
      `DELETE FROM ${table} WHERE eventId IN (SELECT id FROM events WHERE userId = ?)`,
    ).bind(userId);

  await env.DB.batch([
    byEvent('chunks_index'),
    byEvent('locations_index'),
    byEvent('transcripts_index'),
    byEvent('classifications_index'),
    byEvent('closure_reports'),
    byEvent('event_origin'),
    byEvent('integrity_records'),
    byEvent('integrity_heads'),
    byEvent('delivery_records'),
    byEvent('wrapped_keys'),
    byEvent('plaintext_commitments'),
    byEvent('custody_transfers'),
    byEvent('vault_objects'),
    byEvent('investigations'),
    byEvent('audit_log'),
    env.DB.prepare('DELETE FROM events WHERE userId = ?').bind(userId),
    env.DB.prepare(
      'DELETE FROM contact_endpoints WHERE contactId IN (SELECT id FROM contacts WHERE userId = ?)',
    ).bind(userId),
    env.DB.prepare('DELETE FROM contacts WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM guardian_invites WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM webauthn_credentials WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM recovery_codes WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM account_magic_links WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM checkins WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM case_files WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM org_members WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  return { ...preview, dryRun: false, r2Deleted, deleted: true };
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
