/**
 * Brief 30 §C — the signup gate, and the atomicity that makes it trustworthy.
 *
 * The failure this exists to prevent: two people racing the last use of one code and BOTH
 * getting an account. That is not a hypothetical — it is what a read-then-write gate does
 * under concurrency, and a paid code claimed twice is revenue lost and a seat over-issued.
 *
 * The claim is a CONDITIONAL UPDATE, so the database decides the winner, not the
 * application. These tests drive the real claimSignupCode against a fake D1 that models
 * the one property that matters: `UPDATE ... WHERE usedCount < maxUses` only matches while
 * uses remain, and reports how many rows it changed.
 */
import { describe, expect, it } from 'vitest';

import { claimSignupCode, releaseOneUse, signupCodeMessage } from '../src/lib/enrollment';
import type { Env } from '../src/types';

interface CodeRow {
  code: string;
  source: 'consumer' | 'institutional';
  orgId: string | null;
  role: 'survivor' | 'coordinator' | 'admin';
  expiresAt: number | null;
  maxUses: number;
  usedCount: number;
  revoked: number;
  createdBy: string | null;
  createdAt: number;
}

function row(over: Partial<CodeRow> = {}): CodeRow {
  return {
    code: 'ABCD1234XY',
    source: 'consumer',
    orgId: null,
    role: 'survivor',
    expiresAt: null,
    maxUses: 1,
    usedCount: 0,
    revoked: 0,
    createdBy: null,
    createdAt: 0,
    ...over,
  };
}

/**
 * A fake D1 whose UPDATE honours the same WHERE clause the real statement uses. The
 * counter lives in a closure shared by every statement, which is what lets two concurrent
 * claims contend over it exactly as they would in SQLite.
 */
function fakeEnv(store: CodeRow | null) {
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (!store) return null;
                const wanted = String(args[0]);
                return (store.code === wanted ? (store as unknown as T) : null);
              },
              async run() {
                if (!store) return { meta: { changes: 0 } };
                const now = Number(args[1] ?? Date.now());
                if (sql.includes('usedCount + 1')) {
                  // The real conditional UPDATE, modelled faithfully.
                  const ok =
                    store.revoked === 0 &&
                    store.usedCount < store.maxUses &&
                    (store.expiresAt === null || store.expiresAt > now);
                  if (!ok) return { meta: { changes: 0 } };
                  store.usedCount += 1;
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('usedCount - 1')) {
                  if (store.usedCount > 0) store.usedCount -= 1;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return env;
}

const NOW = 1_700_000_000_000;

describe('ATOMICITY — two requests racing the last use, only one wins', () => {
  it('concurrent claims on a single-use code: exactly ONE succeeds', async () => {
    const store = row({ maxUses: 1, usedCount: 0 });
    const env = fakeEnv(store);

    // Fired together, not sequentially — this is the race.
    const [a, b] = await Promise.all([
      claimSignupCode(env, 'ABCD1234XY', NOW),
      claimSignupCode(env, 'ABCD1234XY', NOW),
    ]);

    const wins = [a, b].filter((r) => r.ok).length;
    const losses = [a, b].filter((r) => !r.ok).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    // The loser is told the truth, not a generic error.
    const loser = [a, b].find((r) => !r.ok) as { ok: false; reason: string };
    expect(loser.reason).toBe('exhausted');
    // And the counter never exceeds the ceiling.
    expect(store.usedCount).toBe(1);
  });

  it('ten simultaneous claims on a single-use code: still exactly one', async () => {
    const store = row({ maxUses: 1, usedCount: 0 });
    const env = fakeEnv(store);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimSignupCode(env, 'ABCD1234XY', NOW)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(store.usedCount).toBe(1);
  });

  it('a multi-use code admits exactly maxUses winners, never more', async () => {
    const store = row({ maxUses: 3, usedCount: 0 });
    const env = fakeEnv(store);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimSignupCode(env, 'ABCD1234XY', NOW)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(store.usedCount).toBe(3);
  });
});

describe('a failed signup gives the code back — a paid code is never burned', () => {
  it('releaseOneUse restores the claim so the buyer can retry', async () => {
    const store = row({ maxUses: 1, usedCount: 0 });
    const env = fakeEnv(store);

    const first = await claimSignupCode(env, 'ABCD1234XY', NOW);
    expect(first.ok).toBe(true);
    expect(store.usedCount).toBe(1);

    // Account creation failed (e.g. email_taken) — the route releases the claim.
    await releaseOneUse(env, 'ABCD1234XY');
    expect(store.usedCount).toBe(0);

    // ...and the code works again.
    expect((await claimSignupCode(env, 'ABCD1234XY', NOW)).ok).toBe(true);
  });
});

describe('refusals say WHAT IS WRONG — never generic, never silent', () => {
  it('refuses a missing code', async () => {
    const r = await claimSignupCode(fakeEnv(row()), '', NOW);
    expect(r).toEqual({ ok: false, reason: 'code_required' });
  });

  it('refuses an unknown code', async () => {
    const r = await claimSignupCode(fakeEnv(row()), 'NOTACODE99', NOW);
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a revoked code', async () => {
    const r = await claimSignupCode(fakeEnv(row({ revoked: 1 })), 'ABCD1234XY', NOW);
    expect(r).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses an expired code', async () => {
    const r = await claimSignupCode(fakeEnv(row({ expiresAt: NOW - 1 })), 'ABCD1234XY', NOW);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an already-used code', async () => {
    const r = await claimSignupCode(fakeEnv(row({ maxUses: 1, usedCount: 1 })), 'ABCD1234XY', NOW);
    expect(r).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('every refusal has a message that names the problem', () => {
    for (const reason of ['code_required', 'not_found', 'revoked', 'expired', 'exhausted'] as const) {
      const msg = signupCodeMessage(reason);
      expect(msg.length).toBeGreaterThan(15);
      expect(msg).not.toMatch(/error|failed|invalid request/i);
    }
    expect(signupCodeMessage('expired')).toMatch(/expired/i);
    expect(signupCodeMessage('exhausted')).toMatch(/already been used/i);
    expect(signupCodeMessage('revoked')).toMatch(/cancelled/i);
  });
});

describe('the claim carries what the caller needs to entitle correctly', () => {
  it('a consumer code reports source=consumer with NO org', async () => {
    const r = await claimSignupCode(fakeEnv(row({ source: 'consumer', orgId: null })), 'ABCD1234XY', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.source).toBe('consumer');
    expect(r.claim.orgId).toBeNull();
  });

  it('an institutional code reports its org, so signup can enrol', async () => {
    const env = fakeEnv(row({ source: 'institutional', orgId: 'org-1', role: 'survivor' }));
    const r = await claimSignupCode(env, 'ABCD1234XY', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.source).toBe('institutional');
    expect(r.claim.orgId).toBe('org-1');
  });
});
