/**
 * Session tokens (W8A). HMAC-signed `<userId>.<issuedAt>.<sigHex>` — stateless and
 * **deliberately unexpiring**. Stored in the PWA's localStorage and sent as
 * `Authorization: Bearer <token>` on user-scoped routes. userId is a UUID (no dots), so
 * splitting on '.' is unambiguous.
 *
 * NO EXPIRY. NOT "not yet" — NOT EVER.
 *
 * This is a safety rule, not a convenience one. An idle timeout or a max-age would sign a
 * survivor out silently, and they would discover it at the worst possible moment: opening
 * the app to trigger an alert and being shown a login form instead. A session ends when
 * the person ends it, and at no other time.
 *
 * `issuedAt` is carried for ATTRIBUTION and for the `sessionsValidFrom` comparison, never
 * as a deadline: nothing here compares it to the clock, and nothing may. If a future brief
 * genuinely needs expiring credentials, it must ship SILENT BACKGROUND REFRESH in the same
 * change — a token that can expire without a refresh path is a logout with extra steps.
 * session-persistence.guard.test.ts fails the build if an age check appears here.
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
