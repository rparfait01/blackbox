/**
 * Session tokens (W8A). HMAC-signed `<userId>.<issuedAt>.<sigHex>` — stateless,
 * no expiry in v0 (the user stays signed in until they sign out). Stored in the
 * PWA's localStorage and sent as `Authorization: Bearer <token>` on user-scoped
 * routes. userId is a UUID (no dots), so splitting on '.' is unambiguous.
 */

import { hmacSha256Hex } from '@blackbox/shared';

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

export async function mintSession(
  secret: string,
  userId: string,
  issuedAt: number = Date.now(),
): Promise<string> {
  const sig = await hmacSha256Hex(secret, `${userId}.${issuedAt}`);
  return `${userId}.${issuedAt}.${sig}`;
}

export async function verifySession(
  secret: string,
  token: string,
): Promise<{ userId: string; issuedAt: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [userId, issuedAtStr, sig] = parts as [string, string, string];
  const issuedAt = Number(issuedAtStr);
  if (!userId || !Number.isFinite(issuedAt)) {
    return null;
  }
  const expected = await hmacSha256Hex(secret, `${userId}.${issuedAt}`);
  return constantTimeEqual(expected, sig) ? { userId, issuedAt } : null;
}
