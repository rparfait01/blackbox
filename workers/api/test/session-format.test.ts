import { describe, expect, it } from 'vitest';

import { mintSession, verifySession } from '../src/lib/session';

/**
 * Brief 2 Fix A (scope addition) — the token must not publish the account identifier, and the
 * change must not sign anybody out.
 *
 * Both sides of every comparison, per the ratified rule: a case that passes and a case that fails.
 */
const SECRET = 'test-session-secret-0123456789abcdef';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('the session token does not publish the account identifier', () => {
  it('a freshly minted token does not contain the userId anywhere', async () => {
    const t = await mintSession(SECRET, USER);
    expect(t).not.toContain(USER);
    // nor any recognisable fragment of it
    expect(t).not.toContain(USER.slice(0, 8));
    expect(t.startsWith('bbxs1.')).toBe(true);
  });

  it('PASSES: the identifier round-trips for the server', async () => {
    const issuedAt = 1_700_000_000_000;
    const t = await mintSession(SECRET, USER, issuedAt);
    expect(await verifySession(SECRET, t)).toEqual({ userId: USER, issuedAt });
  });

  it('FAILS: a tampered payload is refused', async () => {
    const t = await mintSession(SECRET, USER);
    const [v, payload, sig] = t.split('.');
    const flipped = payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A');
    expect(await verifySession(SECRET, `${v}.${flipped}.${sig}`)).toBeNull();
  });

  it('FAILS: another secret cannot read or validate it', async () => {
    const t = await mintSession(SECRET, USER);
    expect(await verifySession('a-different-secret-aaaaaaaaaaaaaaaa', t)).toBeNull();
  });

  it('two tokens for the same user differ — the token is not a stable identifier either', async () => {
    // A constant ciphertext would still let two logs be correlated to one account.
    const a = await mintSession(SECRET, USER, 1);
    const b = await mintSession(SECRET, USER, 1);
    expect(a).not.toBe(b);
  });
});

describe('legacy tokens keep working — nobody is signed out', () => {
  // Sessions never expire and no error path may end one. Rejecting the old format would sign out
  // every currently signed-in user, which is its own safety failure.
  const legacy = async (): Promise<string> => {
    const { hmacSha256Hex } = await import('@blackbox/shared');
    const issuedAt = 1_600_000_000_000;
    const sig = await hmacSha256Hex(SECRET, `${USER}.${issuedAt}`);
    return `${USER}.${issuedAt}.${sig}`;
  };

  it('PASSES: a legacy token still authenticates', async () => {
    expect(await verifySession(SECRET, await legacy())).toEqual({ userId: USER, issuedAt: 1_600_000_000_000 });
  });

  it('FAILS: a legacy token with a bad signature is still refused', async () => {
    const t = await legacy();
    expect(await verifySession(SECRET, `${t.slice(0, -1)}${t.slice(-1) === 'a' ? 'b' : 'a'}`)).toBeNull();
  });

  it('legacy tokens are no longer MINTED, which is what closes the disclosure', async () => {
    const t = await mintSession(SECRET, USER);
    expect(t.split('.')[0]).toBe('bbxs1');
  });
});
