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
 *
 * THE TRADE THIS MAKES, ACCEPTED DELIBERATELY.
 *
 * A never-expiring passwordless session means a found or unlocked device stays signed in.
 * That is a real cost and it is the right one to pay here. Weigh the two failures against
 * each other:
 *
 *   - Silent logout: a survivor's safety device is dead and SHE DOES NOT KNOW IT. She
 *     finds out by pressing the trigger and getting a login form. There is no recovery
 *     from that in the moment it matters.
 *   - Device compromise: someone else holds an unlocked phone. This threat is already
 *     carried by other layers — the covert facade means the app does not announce what it
 *     is, closure is a gesture rather than a stored secret, and the physical-device
 *     assumption underpins the whole design.
 *
 * The first failure is silent, unrecoverable, and hits the person we exist to protect at
 * the exact moment of crisis. The second is loud, already mitigated, and does not disarm
 * anyone. So the session persists until it is explicitly ended.
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

/**
 * Brief 2 Fix A (scope addition) — THE TOKEN MUST NOT PUBLISH THE ACCOUNT IDENTIFIER.
 *
 * The old format was `<userId>.<issuedAt>.<hmac>`: the account identifier in plaintext, as the
 * first component of every session token this product has ever issued. That was survivable only
 * while a userId granted nothing, and it did not — until Brief 30 Fix A a bare userId finalized
 * any account into a full session. So every session token ever logged, screenshotted or pasted
 * into a support thread also carried a permanent key to the account it belonged to.
 *
 * DERIVED, NOT OPAQUE, and the reason is §0. An opaque token would mean a random id looked up in
 * D1 on every authenticated request — and `POST /v1/events`, the trigger, verifies a session. A
 * database read on the path between a survivor and an alert is exactly what §0 forbids. So the
 * identifier is ENCRYPTED into the token instead: AES-GCM under a key derived from the existing
 * session secret, recovered locally with no I/O at all.
 *
 * ADDITIVE, because sessions never expire and signing out every live user is itself a safety
 * failure (see `no-unintentional-signout`). New tokens use this format; `verifySession` still
 * accepts the legacy one indefinitely. Nobody is logged out by this change.
 */
const V2 = 'bbxs1';

/** Derived AES key per secret, cached: HKDF on every request would be a latency cost for nothing. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKeyFor(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('bbx.session.v1') },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(secret, k);
  }
  return k;
}

const b64u = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string): Uint8Array => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function mintSession(
  secret: string,
  userId: string,
  issuedAt: number = Date.now(),
): Promise<string> {
  const key = await aesKeyFor(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(`${userId}.${issuedAt}`)),
  );
  const payload = b64u(new Uint8Array([...iv, ...ct]));
  const sig = await hmacSha256Hex(secret, `${V2}.${payload}`);
  return `${V2}.${payload}.${sig}`;
}

export async function verifySession(
  secret: string,
  token: string,
): Promise<{ userId: string; issuedAt: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  // NEW FORMAT. The identifier is inside the ciphertext, so nothing about the account can be read
  // off the token. Signature first, then decrypt: an attacker must not be able to use decryption
  // failures as an oracle on tokens they forged.
  if (parts[0] === V2) {
    const [, payload, sig] = parts as [string, string, string];
    const expectedSig = await hmacSha256Hex(secret, `${V2}.${payload}`);
    if (!constantTimeEqual(expectedSig, sig)) return null;
    try {
      const raw = unb64u(payload);
      const key = await aesKeyFor(secret);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
      const [userId, issuedAtStr] = new TextDecoder().decode(pt).split('.') as [string, string];
      const issuedAt = Number(issuedAtStr);
      return userId && Number.isFinite(issuedAt) ? { userId, issuedAt } : null;
    } catch {
      return null;
    }
  }

  // LEGACY FORMAT, accepted indefinitely. Sessions never expire and no error path may end one;
  // rejecting these would sign out every currently signed-in user, which is its own safety
  // failure. They stop being MINTED, which is what closes the disclosure going forward.
  const [userId, issuedAtStr, sig] = parts as [string, string, string];
  const issuedAt = Number(issuedAtStr);
  if (!userId || !Number.isFinite(issuedAt)) {
    return null;
  }
  const expected = await hmacSha256Hex(secret, `${userId}.${issuedAt}`);
  return constantTimeEqual(expected, sig) ? { userId, issuedAt } : null;
}
