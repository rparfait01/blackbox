/**
 * Brief 34 §1 — the buyer's Gumroad licence key IS the access code.
 *
 * What these pin: we never trust a client claim that a purchase happened, a refunded sale
 * cannot buy access, an outage is not reported as a bad key, and one key can only ever
 * create one account — including when two signups race the same fresh key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  claimGumroadLicense,
  licenseAlreadyRedeemed,
  licenseMessage,
  verifyGumroadLicense,
} from '../src/lib/gumroad-license';
import type { Env } from '../src/types';

const PRODUCT = 'prod-abc';

function envWith(store: Set<string>, product: string | undefined = PRODUCT): Env {
  return {
    GUMROAD_PRODUCT_ID: product,
    DB: {
      prepare(_sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                return (store.has(String(args[0])) ? ({ hit: 1 } as unknown as T) : null);
              },
              async run() {
                // Models INSERT ... ON CONFLICT DO NOTHING against a PRIMARY KEY.
                const key = String(args[0]);
                if (store.has(key)) return { meta: { changes: 0 } };
                store.add(key);
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

function gumroadReplies(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe('verification is server-to-server, and never trusts the client', () => {
  it('accepts a live purchase of OUR product', async () => {
    gumroadReplies({ success: true, purchase: { email: 'buyer@example.com' } });
    const r = await verifyGumroadLicense(envWith(new Set()), 'KEY-1');
    expect(r.ok).toBe(true);
    expect(r.buyerEmail).toBe('buyer@example.com');
  });

  it('pins the product — the request carries product_id and does NOT increment uses', async () => {
    let sentBody = '';
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ success: true, purchase: {} }), { status: 200 });
    });
    await verifyGumroadLicense(envWith(new Set()), 'KEY-2');
    expect(sentBody).toContain(`product_id=${PRODUCT}`);
    expect(sentBody).toContain('license_key=KEY-2');
    // Our ledger is the source of truth for redemption; burning Gumroad's counter would
    // make our gate depend on their mutable state and would count a failed signup.
    expect(sentBody).toContain('increment_uses_count=false');
  });

  it('refuses an unknown key (404)', async () => {
    gumroadReplies({}, 404);
    const r = await verifyGumroadLicense(envWith(new Set()), 'NOPE');
    expect(r).toEqual({ ok: false, reason: 'invalid_license' });
  });

  it('refuses success:false', async () => {
    gumroadReplies({ success: false });
    expect((await verifyGumroadLicense(envWith(new Set()), 'X')).reason).toBe('invalid_license');
  });

  it('REFUSES a refunded / disputed / cancelled purchase — a refund ends access', async () => {
    for (const dead of [
      { refunded: true },
      { disputed: true },
      { chargebacked: true },
      { subscription_cancelled_at: '2026-01-01' },
      { subscription_failed_at: '2026-01-01' },
    ]) {
      gumroadReplies({ success: true, purchase: dead });
      const r = await verifyGumroadLicense(envWith(new Set()), 'K');
      expect(r.ok, JSON.stringify(dead)).toBe(false);
      expect(r.reason).toBe('refunded_or_cancelled');
    }
  });

  it('an outage is NOT reported as a bad key — a paying customer is not called a liar', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    expect((await verifyGumroadLicense(envWith(new Set()), 'K')).reason).toBe('verify_unavailable');
    gumroadReplies({}, 500);
    expect((await verifyGumroadLicense(envWith(new Set()), 'K')).reason).toBe('verify_unavailable');
  });

  it('fails closed with no product pinned — we cannot tell our sale from anyone else’s', async () => {
    gumroadReplies({ success: true, purchase: {} });
    // '' not undefined — an explicit undefined would trigger the default parameter.
    const r = await verifyGumroadLicense(envWith(new Set(), ''), 'K');
    expect(r).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('ONE KEY = ONE ACCOUNT, atomically', () => {
  it('two concurrent claims on the same fresh key: exactly one lands', async () => {
    const store = new Set<string>();
    const env = envWith(store);
    const [a, b] = await Promise.all([
      claimGumroadLicense(env, 'RACE-KEY', null, 1),
      claimGumroadLicense(env, 'RACE-KEY', null, 1),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('a second, later claim is refused', async () => {
    const store = new Set<string>();
    const env = envWith(store);
    expect(await claimGumroadLicense(env, 'K1', null, 1)).toBe(true);
    expect(await claimGumroadLicense(env, 'K1', null, 1)).toBe(false);
  });

  it('normalizes so case and dashes cannot create a second account from one key', async () => {
    const store = new Set<string>();
    const env = envWith(store);
    expect(await claimGumroadLicense(env, 'ABCD-1234', null, 1)).toBe(true);
    expect(await claimGumroadLicense(env, 'abcd1234', null, 1)).toBe(false);
    expect(await licenseAlreadyRedeemed(env, 'AbCd-1234')).toBe(true);
  });
});

describe('refusals name the problem', () => {
  it('every reason has a message that says what is wrong', () => {
    for (const r of ['invalid_license', 'already_redeemed', 'refunded_or_cancelled', 'verify_unavailable', 'not_configured'] as const) {
      expect(licenseMessage(r).length).toBeGreaterThan(20);
    }
    expect(licenseMessage('already_redeemed')).toMatch(/already been used/i);
    expect(licenseMessage('refunded_or_cancelled')).toMatch(/refunded|cancelled/i);
    expect(licenseMessage('verify_unavailable')).toMatch(/try again/i);
  });
});
