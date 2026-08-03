import { describe, expect, it } from 'vitest';

import { rotateSession, revokeToken, sessionFormat, tokenHash } from '../src/lib/session-rotation';
import { mintSession, verifySession } from '../src/lib/session';

/**
 * Brief 42 §C/§E5.
 *
 * §E5 puts this near the trigger path: "a rotation bug that invalidates a valid session is a
 * survivor who cannot trigger", so every comparison is proven BOTH ways — a case that rotates and
 * a case that must not be allowed to break the session.
 */
const SECRET = 'rotation-test-secret-0123456789ab';
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';

const envWith = (opts: { throws?: boolean; secret?: string | null } = {}) => {
  const inserted: string[] = [];
  return {
    env: {
      SESSION_SECRET: opts.secret === undefined ? SECRET : opts.secret,
      DB: {
        prepare(sql: string) {
          if (opts.throws) throw new Error('D1 unavailable');
          return {
            bind(...args: unknown[]) {
              if (/INSERT OR IGNORE INTO revoked_sessions/.test(sql)) inserted.push(String(args[0]));
              return this;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
            async first() {
              return null;
            },
          };
        },
      },
    } as never,
    inserted,
  };
};

describe('§C rotation emits bbxs1 whatever it was handed', () => {
  it('a LEGACY token in → bbxs1 out, and the holder is never asked to re-authenticate', async () => {
    const legacy = `${USER}.1600000000000.deadbeef`;
    const { env } = envWith();
    const r = await rotateSession(env, { userId: USER, presentedToken: legacy, reason: 'test' });
    expect(r).not.toBeNull();
    expect(r!.previousFormat).toBe('legacy');
    expect(r!.token.startsWith('bbxs1.')).toBe(true);
    // The new token authenticates immediately — no credential prompt anywhere in this path.
    expect(await verifySession(SECRET, r!.token)).toMatchObject({ userId: USER });
  });

  it('a bbxs1 token in → bbxs1 out', async () => {
    const current = await mintSession(SECRET, USER);
    const { env } = envWith();
    const r = await rotateSession(env, { userId: USER, presentedToken: current, reason: 'test' });
    expect(r!.previousFormat).toBe('bbxs1');
    expect(r!.token.startsWith('bbxs1.')).toBe(true);
    expect(r!.token).not.toBe(current);
  });

  it('the PRESENTED token is the one revoked — by hash, never stored in the clear', async () => {
    const presented = await mintSession(SECRET, USER);
    const { env, inserted } = envWith();
    await rotateSession(env, { userId: USER, presentedToken: presented, reason: 'test' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toBe(await tokenHash(presented));
    // The revocation row must not contain the token itself.
    expect(inserted[0]).not.toContain(presented);
    expect(inserted[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('format detection handles junk without throwing', () => {
    expect(sessionFormat('bbxs1.a.b')).toBe('bbxs1');
    expect(sessionFormat('uuid.123.sig')).toBe('legacy');
    expect(sessionFormat('nonsense')).toBeNull();
    expect(sessionFormat(null)).toBeNull();
    expect(sessionFormat('')).toBeNull();
  });
});

describe('§E5 every failure resolves toward the session continuing to work', () => {
  it('a revocation store that throws still returns a working new token', async () => {
    // The transition must not be blocked because a revocation write failed. The old token
    // outliving it is a smaller harm than a privilege change that cannot complete.
    const { env } = envWith({ throws: true });
    const r = await rotateSession(env, { userId: USER, presentedToken: 'x.y.z', reason: 'test' });
    expect(r).not.toBeNull();
    expect(r!.token.startsWith('bbxs1.')).toBe(true);
    expect(r!.rotated).toBe(false); // honest: it says the revocation did not happen
  });

  it('revokeToken reports failure rather than throwing into the caller', async () => {
    const { env } = envWith({ throws: true });
    await expect(revokeToken(env, 'a.b.c', USER, 'test')).resolves.toBe(false);
  });

  it('no secret → returns null so the caller KEEPS the token it had', async () => {
    // Returning null, not an empty string: the caller falls back rather than handing out
    // something unusable. A caller left with no token is a survivor signed out.
    const { env } = envWith({ secret: null });
    expect(await rotateSession(env, { userId: USER, presentedToken: 'a.b.c', reason: 'test' })).toBeNull();
  });

  it('rotating with NO presented token still issues one, and revokes nothing', async () => {
    // anonymous → authenticated: there is no old identifier to invalidate.
    const { env, inserted } = envWith();
    const r = await rotateSession(env, { userId: USER, presentedToken: null, reason: 'signin' });
    expect(r!.token.startsWith('bbxs1.')).toBe(true);
    expect(inserted).toHaveLength(0);
  });

  it('rotation never returns the token it was given', async () => {
    // If it did, the revocation would invalidate the token just handed back — the exact
    // "invalidates a valid session" bug §E5 names.
    const presented = await mintSession(SECRET, USER);
    const { env } = envWith();
    const r = await rotateSession(env, { userId: USER, presentedToken: presented, reason: 'test' });
    expect(r!.token).not.toBe(presented);
  });
});
