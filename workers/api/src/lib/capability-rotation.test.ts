import { describe, expect, it } from 'vitest';

import {
  mintCapability,
  verifyCapability,
  CAPABILITY_TTL_MS,
} from './signup-capability';

/**
 * Brief 30 Fix A §E3 + the ratified comparison rule.
 *
 * A new comparison requires proving the comparing side can produce the value, and BOTH sides are
 * exercised: a case that passes and a case that fails. Proven-by-construction is what
 * `expectedPublicKey` looked like, and a real rotation on staging is what caught this — the
 * binding was recomputed with whatever key was CURRENT, so a rotation refused every in-flight
 * capability and, because secret propagation across isolates is not atomic, freshly minted ones too.
 */
const K1 = 'key-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const K2 = 'key-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const env = (current?: string, previous?: string, session = 'session-secret-xxxxxxxxxxxxxxxx') =>
  ({ SIGNUP_CAPABILITY_SECRET: current, SIGNUP_CAPABILITY_SECRET_PREVIOUS: previous, SESSION_SECRET: session }) as never;

describe('§E3 rotation — both sides', () => {
  it('PASSES: a capability minted under K1 still verifies after K1 becomes previous', async () => {
    const before = env(K1);
    const token = (await mintCapability(before, { sub: 'u1', scope: ['signup:finalize'], bind: null }))!;
    const after = env(K2, K1); // rotated
    const r = await verifyCapability(after, token, 'signup:finalize');
    expect(r.ok, r.reason).toBe(true);
  });

  it('FAILS: once K1 is fully retired, its capabilities no longer verify', async () => {
    // The other side of the same comparison. If this passed, "rotation" would mean nothing.
    const token = (await mintCapability(env(K1), { sub: 'u1', scope: ['signup:finalize'], bind: null }))!;
    const r = await verifyCapability(env(K2, undefined, 'unrelated-session-secret-yyyy'), token, 'signup:finalize');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capability_bad_signature');
  });

  it('PASSES: a BOUND capability survives rotation, because the binding uses the signing key', async () => {
    // This is the case the staging rotation actually failed. The commitment must be recomputed
    // with the key that signed the token, never with whichever key happens to be current.
    const nonce = 'client-nonce-123';
    const before = env(K1);
    const bind = (await import('./signup-capability')).bindingCommitment;
    const token = (await mintCapability(before, {
      sub: 'u1',
      scope: ['signup:finalize'],
      bind: await bind(K1, nonce),
    }))!;
    const r = await verifyCapability(env(K2, K1), token, 'signup:finalize', { bindNonce: nonce });
    expect(r.ok, r.reason).toBe(true);
  });

  it('FAILS: a bound capability presented with the WRONG nonce is refused after rotation too', async () => {
    const bind = (await import('./signup-capability')).bindingCommitment;
    const token = (await mintCapability(env(K1), {
      sub: 'u1',
      scope: ['signup:finalize'],
      bind: await bind(K1, 'right-nonce'),
    }))!;
    const r = await verifyCapability(env(K2, K1), token, 'signup:finalize', { bindNonce: 'wrong-nonce' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capability_binding_mismatch');
  });

  it('FAILS: a bound capability presented with NO nonce is refused', async () => {
    const bind = (await import('./signup-capability')).bindingCommitment;
    const token = (await mintCapability(env(K1), {
      sub: 'u1',
      scope: ['signup:finalize'],
      bind: await bind(K1, 'n'),
    }))!;
    expect((await verifyCapability(env(K1), token, 'signup:finalize')).reason).toBe('capability_binding_mismatch');
  });

  it('PASSES then FAILS: scope and expiry each have a working both-ways case', async () => {
    const e = env(K1);
    const token = (await mintCapability(e, { sub: 'u1', scope: ['signup:passkey'], bind: null }))!;
    expect((await verifyCapability(e, token, 'signup:passkey')).ok).toBe(true);
    expect((await verifyCapability(e, token, 'signup:finalize')).reason).toBe('capability_out_of_scope');

    const now = Date.now();
    const short = (await mintCapability(e, { sub: 'u1', scope: ['signup:finalize'], bind: null, now }))!;
    expect((await verifyCapability(e, short, 'signup:finalize', { now })).ok).toBe(true);
    expect((await verifyCapability(e, short, 'signup:finalize', { now: now + CAPABILITY_TTL_MS + 1 })).reason).toBe(
      'capability_expired',
    );
  });
});
