/**
 * Account magic link — the NO-PASSKEY FALLBACK ONLY (Accounts §1b).
 *
 * This is the one email-based way into an account, and it is deliberately fenced:
 *
 *   §2 forbids password-reset-by-email because the survivor's abuser may be
 *   monitoring the inbox. That reasoning does not stop at the word "reset" — an
 *   emailed LOGIN link hands over exactly the same thing. So the link is refused
 *   the moment the account holds a passkey (`hasPasskey`): once the survivor has a
 *   credential that lives in their device keychain, email stops being a door, and
 *   an abuser reading the inbox gets nothing.
 *
 * It still exists, because the alternative is worse: a device that cannot do
 * WebAuthn, or a pilot account mid-migration, must not be a dead end. It is the
 * bridge, not the destination.
 *
 * Token discipline mirrors password_resets (0023): random 32 bytes, only the
 * SHA-256 hash is stored, single-use, short TTL. NOT a stateless HMAC like the
 * event-scoped lib/magic-link.ts — a stateless account token would be replayable
 * for its whole lifetime, and would entangle MAGIC_LINK_SECRET (which
 * sessionSecret() falls back to) with account auth. Separate stores, separate
 * blast radius.
 */

import { sha256Hex } from '@blackbox/shared';
import { getUserByEmail, isActive } from './users';
import { hasPasskey } from './passkey';
import type { Env } from '../types';

/** Short — this is a live login credential sitting in an inbox. */
const LINK_TTL_MS = 15 * 60 * 1000;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export type MagicLinkRefusal = 'no_account' | 'has_passkey';

/**
 * Issue a login link for the email, or refuse.
 *
 * Refusals are NOT surfaced to the caller's response — the route answers 200
 * either way so neither account existence nor passkey state leaks to someone
 * probing the endpoint. The reason is returned here only so the route can decide
 * whether to actually send mail, and so the refusal can be audited.
 */
export async function createMagicLink(
  env: Env,
  email: string,
): Promise<{ token: string } | { refused: MagicLinkRefusal }> {
  const user = await getUserByEmail(env, email);
  if (!user || !isActive(user)) return { refused: 'no_account' };
  // THE GATE: a passkey-enrolled account is not reachable by email.
  if (await hasPasskey(env, user.id)) return { refused: 'has_passkey' };

  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO account_magic_links (tokenHash, userId, expiresAt, consumedAt, createdAt) VALUES (?, ?, ?, NULL, ?)',
  )
    .bind(await tokenHash(token), user.id, now + LINK_TTL_MS, now)
    .run();
  return { token };
}

/**
 * Redeem a link → the userId to mint a session for, or null when the token is
 * unknown, expired, or already used. Consumed atomically (single-use).
 *
 * The passkey gate is re-checked at REDEEM time, not just at issue time: if a
 * passkey was enrolled after the link was mailed, the link is dead on arrival.
 * Otherwise an abuser could trigger a link, wait, and use it after the survivor
 * had secured the account.
 *
 * Deliberately does NOT bump sessionsValidFrom — that is global-per-user and would
 * sign the survivor out of their other devices. Signing in must never be an event
 * that logs you out somewhere else, least of all mid-crisis.
 */
export async function consumeMagicLink(env: Env, token: string): Promise<string | null> {
  const hash = await tokenHash(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT userId, expiresAt, consumedAt FROM account_magic_links WHERE tokenHash = ?',
  )
    .bind(hash)
    .first<{ userId: string; expiresAt: number; consumedAt: number | null }>();
  if (!row || row.consumedAt != null || row.expiresAt < now) return null;
  // Consume first: a concurrent replay finds it already spent.
  const spent = await env.DB.prepare(
    'UPDATE account_magic_links SET consumedAt = ? WHERE tokenHash = ? AND consumedAt IS NULL',
  )
    .bind(now, hash)
    .run();
  if (spent.meta.changes !== 1) return null;
  if (await hasPasskey(env, row.userId)) return null;
  return row.userId;
}
