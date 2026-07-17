/**
 * Recovery codes — the discreet backup credential (Accounts §2).
 *
 * The passkey normally restores itself: iCloud Keychain / Google Password Manager
 * syncs it to the survivor's new device when they sign into their Apple/Google
 * account. That covers the ordinary "new phone" case with no in-app flow for an
 * abuser to intercept.
 *
 * This covers the case the keychain does not: device lost AND keychain
 * unavailable (different ecosystem, account locked out, no cloud backup). It is
 * NOT emailed — that is the whole point. The code is shown ONCE at setup and the
 * survivor keeps it (an org holds it for org-enrolled survivors, later — Tenancy).
 * Nothing about it touches the inbox, so a monitored inbox does not reach it.
 *
 * Storage matches users.passwordHash: PBKDF2 via lib/crypto, so only a hash is at
 * rest and `verifySecret` reads it directly. Single-use — a code that has been
 * spent cannot be replayed, and a survivor who uses one is issued fresh codes.
 */

import { hashSecret, verifySecret } from './crypto';
import type { Env } from '../types';

/** How many codes are minted per account. */
const CODE_COUNT = 1;

/**
 * Crockford-style base32 without I/L/O/U — no character an anxious person can
 * misread, and nothing that can form a word. Grouped for legibility when written
 * down, e.g. "K4M9-XR2T-8PBW".
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 3;
const GROUP_LEN = 4;

function generateCode(): string {
  const bytes = new Uint8Array(GROUPS * GROUP_LEN);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  const out: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    out.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  }
  return out.join('-');
}

/** Normalize user entry: case-insensitive, dashes/spaces optional. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Mint fresh recovery codes for a user, REPLACING any existing ones. Returns the
 * plaintext codes — the ONLY time they are ever visible. They are not recoverable
 * afterwards; if the survivor loses them, they regenerate (which invalidates the
 * old set).
 */
export async function issueRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM recovery_codes WHERE userId = ?').bind(userId).run();
  const codes: string[] = [];
  for (let i = 0; i < CODE_COUNT; i += 1) {
    const code = generateCode();
    codes.push(code);
    await env.DB.prepare(
      'INSERT INTO recovery_codes (id, userId, codeHash, consumedAt, createdAt) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind(crypto.randomUUID(), userId, await hashSecret(normalizeCode(code)), now)
      .run();
  }
  return codes;
}

export async function hasRecoveryCode(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS n FROM recovery_codes WHERE userId = ? AND consumedAt IS NULL LIMIT 1',
  )
    .bind(userId)
    .first<{ n: number }>();
  return !!row;
}

/**
 * Redeem a code for an account → true on success (single-use, consumed).
 *
 * Scoped to a known userId rather than searching every account by code: a global
 * lookup would let an attacker spray guesses against the whole user base at once.
 * The caller resolves the account first (by email), so a guess is bounded to one
 * account — and PBKDF2 at 100k iterations makes each attempt expensive.
 */
export async function consumeRecoveryCode(env: Env, userId: string, input: string): Promise<boolean> {
  const candidate = normalizeCode(input);
  if (!candidate) return false;
  const { results } = await env.DB.prepare(
    'SELECT id, codeHash FROM recovery_codes WHERE userId = ? AND consumedAt IS NULL',
  )
    .bind(userId)
    .all<{ id: string; codeHash: string }>();
  for (const row of results ?? []) {
    if (await verifySecret(candidate, row.codeHash)) {
      // Consume atomically — a concurrent replay of the same code loses the race.
      const spent = await env.DB.prepare(
        'UPDATE recovery_codes SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL',
      )
        .bind(Date.now(), row.id)
        .run();
      return spent.meta.changes === 1;
    }
  }
  return false;
}
