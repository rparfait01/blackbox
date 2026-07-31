/**
 * Stateless magic-link tokens (W6). A token grants read-only access to ONE event
 * for a limited time, with no login and no per-request database lookup — the
 * HMAC signature is the entire proof. Used for the contact's live view link and
 * the audio-preview link embedded in the LINE message.
 *
 * Token format: `<expiryMs>.<hmacSha256Hex(secret, "<eventId>.<expiryMs>")>`.
 * Scoped to the eventId (the signature covers it) and self-expiring (the worker
 * checks expiry without storing anything).
 */

import { hmacSha256Hex } from '@blackbox/shared';

export const MAGIC_LINK_TTL_MS = 60 * 60 * 1000; // 1 hour

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function mintMagicToken(
  secret: string,
  eventId: string,
  now: number = Date.now(),
  ttlMs: number = MAGIC_LINK_TTL_MS,
): Promise<string> {
  const expiry = now + ttlMs;
  const signature = await hmacSha256Hex(secret, `${eventId}.${expiry}`);
  return `${expiry}.${signature}`;
}

/**
 * Role-scoped tokens (Fix Brief 3). The guardian/coordinator path uses a legacy
 * 2-part token (no role) and resolves straight to the live dashboard. The
 * authority path uses a 3-part role token (`<role>.<expiry>.<sig>`) and is the
 * ONLY thing that triggers the C1 verify-identity gate.
 *
 * Format: `<role>.<expiry>.<hmac(secret, "<eventId>.<role>.<expiry>")>`.
 */
export type TokenRole = 'guardian' | 'coordinator' | 'notified' | 'dispatch';

export async function mintRoleToken(
  secret: string,
  eventId: string,
  role: TokenRole,
  now: number = Date.now(),
  ttlMs: number = MAGIC_LINK_TTL_MS,
): Promise<string> {
  const expiry = now + ttlMs;
  const signature = await hmacSha256Hex(secret, `${eventId}.${role}.${expiry}`);
  return `${role}.${expiry}.${signature}`;
}

export interface RoleVerdict {
  verdict: TokenVerdict;
  /** Resolved role; a legacy (role-less) token resolves to 'guardian'. */
  role: TokenRole;
}

const ROLES: TokenRole[] = ['guardian', 'coordinator', 'notified', 'dispatch'];

/**
 * Verify a token and resolve its role. Accepts both the legacy 2-part guardian
 * token (role → 'guardian') and the 3-part role token.
 */
export async function verifyTokenRole(
  secret: string,
  eventId: string,
  token: string,
  now: number = Date.now(),
): Promise<RoleVerdict> {
  const parts = token.split('.');
  if (parts.length === 3 && ROLES.includes(parts[0] as TokenRole)) {
    const role = parts[0] as TokenRole;
    const expiry = Number(parts[1]);
    if (!Number.isFinite(expiry)) {
      return { verdict: 'invalid', role };
    }
    const expected = await hmacSha256Hex(secret, `${eventId}.${role}.${expiry}`);
    if (!constantTimeEqual(expected, parts[2]!)) {
      return { verdict: 'invalid', role };
    }
    return { verdict: now > expiry ? 'expired' : 'ok', role };
  }
  // Legacy 2-part token → guardian path.
  return { verdict: await verifyMagicTokenDetailed(secret, eventId, token, now), role: 'guardian' };
}

export type TokenVerdict = 'ok' | 'expired' | 'invalid';

/**
 * Verify a token, distinguishing a correctly-signed-but-expired token (so the
 * dashboard can show a friendly "this link expired, check LINE for a new one"
 * page) from a malformed or wrongly-signed one.
 */
export async function verifyMagicTokenDetailed(
  secret: string,
  eventId: string,
  token: string,
  now: number = Date.now(),
): Promise<TokenVerdict> {
  const dot = token.indexOf('.');
  if (dot <= 0) {
    return 'invalid';
  }
  const expiryStr = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) {
    return 'invalid';
  }
  const expected = await hmacSha256Hex(secret, `${eventId}.${expiry}`);
  if (!constantTimeEqual(expected, signature)) {
    return 'invalid';
  }
  return now > expiry ? 'expired' : 'ok';
}

export async function verifyMagicToken(
  secret: string,
  eventId: string,
  token: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await verifyMagicTokenDetailed(secret, eventId, token, now)) === 'ok';
}
