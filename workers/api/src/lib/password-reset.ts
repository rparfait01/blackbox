/**
 * Forgot-password (Fix Brief 15 §D). A single-use, expiring reset token is
 * issued to the account email; only its SHA-256 hash is stored. Redeeming it
 * sets the new password and bumps the user's sessionsValidFrom so every session
 * minted before the reset is rejected (old sessions invalidated).
 */

import { sha256Hex } from '@blackbox/shared';
import { hashSecret } from './crypto';
import { getUserByEmail } from './users';
import type { Env } from '../types';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

/**
 * Issue a reset token for the email if an account exists. Returns the raw token
 * (for the email link) or null when there is no account — the caller stays
 * silent either way so account existence never leaks.
 */
export async function createResetToken(env: Env, email: string): Promise<string | null> {
  const user = await getUserByEmail(env, email);
  if (!user) return null;
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO password_resets (tokenHash, userId, expiresAt, consumedAt, createdAt) VALUES (?, ?, ?, NULL, ?)',
  )
    .bind(await tokenHash(token), user.id, now + RESET_TTL_MS, now)
    .run();
  return token;
}

/**
 * Redeem a reset token: set the new password and invalidate older sessions.
 * Returns true on success; false if the token is unknown, already used, or
 * expired. Single-use — consumed atomically before the password is changed.
 */
export async function consumeResetToken(env: Env, token: string, newPassword: string): Promise<boolean> {
  const hash = await tokenHash(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT userId, expiresAt, consumedAt FROM password_resets WHERE tokenHash = ?',
  )
    .bind(hash)
    .first<{ userId: string; expiresAt: number; consumedAt: number | null }>();
  if (!row || row.consumedAt != null || row.expiresAt < now) return false;
  await env.DB.prepare('UPDATE password_resets SET consumedAt = ? WHERE tokenHash = ?').bind(now, hash).run();
  await env.DB.prepare('UPDATE users SET passwordHash = ?, sessionsValidFrom = ?, updatedAt = ? WHERE id = ?')
    .bind(await hashSecret(newPassword), now, now, row.userId)
    .run();
  return true;
}
