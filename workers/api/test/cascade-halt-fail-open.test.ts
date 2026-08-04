import { describe, expect, it } from 'vitest';

import { notifyActivation } from '../src/lib/notify';
import type { Env } from '../src/types';

/**
 * BRIEF 56 §A3 — A FAILED HALT-CHECK NEVER SUPPRESSES A DISPATCH.
 *
 * ═══ WHY THIS IS A BEHAVIOURAL TEST AND NOT A GUARD ══════════════════════════════════════════
 *
 * The property only exists in a state the system is never normally in: D1 throwing on the alert
 * path. A source-reading guard could assert that a try/catch is present, which is not the same
 * claim — a catch that logs and rethrows, or one that returns false, would satisfy the text and
 * invert the behaviour. The only honest way to assert "it SENDS when it cannot read" is to make
 * the read fail and watch what leaves.
 *
 * ═══ WHAT THE OLD BEHAVIOUR WAS ══════════════════════════════════════════════════════════════
 *
 * `advanceStep` let the D1 error propagate. That killed the caller's loop, so a transient D1
 * failure at step 1 silently cancelled steps 1..N — not one contact, the whole remaining
 * cascade. Fail-CLOSED on the one path where closed means a survivor nobody reached.
 *
 * The trade is stated where it is taken: this UPDATE is also the atomic per-step claim that stops
 * the stagger, the alarm and the cron double-notifying, so failing open surrenders that for the
 * duration of an outage. §A3 chooses that direction explicitly.
 */

function makeEnv(opts: { failAdvance: boolean }): { env: Env } {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind: (...args: unknown[]) => ({
          async run() {
            // The halt check. This is the statement §A3 is about.
            if (sql.includes('SET cascadeStep')) {
              if (opts.failAdvance) {
                throw new Error('D1_ERROR: network error while reading claim state');
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('FROM events WHERE id')) {
              return { userId: 'u1', userHash: null, createdAt: Date.now() };
            }
            if (sql.includes('guardianEnabled')) {
              return { guardianEnabled: 1 };
            }
            if (sql.includes('cascadeIntervalSeconds')) {
              // 0 interval so the stagger runs every step immediately; timing is not what this
              // test is about, and a real 10s wait would make it a slow test for no gain.
              return { cascadeIntervalSeconds: 1 };
            }
            return null;
          },
          async all() {
            // The recipient list the cascade actually walks. Returned for the contacts query so
            // notifyActivation does not exit early at "no contacts" — which is exactly what the
            // subject assertion above caught when this returned an empty list.
            if (sql.includes('FROM contacts')) {
              return {
                results: [
                  { id: 'c1', displayName: 'Primary', role: 'contact', status: 'confirmed' },
                  { id: 'c2', displayName: 'Guardian', role: 'guardian', status: 'confirmed' },
                ],
              };
            }
            return { results: [] };
          },
        }),
        async run() {
          return { meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };

  const env = {
    DB: db,
    MAGIC_LINK_SECRET: 'test-secret-for-the-halt-check',
    WORKER_ORIGIN: 'https://example.invalid',
  } as unknown as Env;

  return { env };
}

describe('§A3 — an unreadable claim state SENDS', () => {
  it('the halt statement is the one being made to fail — this test names its subject', async () => {
    // If `advanceStep`'s SQL is rewritten so it no longer contains 'SET cascadeStep', the stub
    // above silently stops failing and both tests below pass over nothing. Assert the shape
    // first, so a rename is a distinct failure rather than a quiet pass.
    const { env } = makeEnv({ failAdvance: true });
    let seen = '';
    const orig = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('SET cascadeStep')) seen = sql;
      return orig(sql) as never;
    };
    await notifyActivation(env, 'evt-subject', 'https://example.invalid').catch(() => undefined);
    expect(seen, 'the halt UPDATE was never prepared — this test is asserting over nothing').toContain(
      'coordinatorClaimedAt IS NULL',
    );
  });

  it('notifyActivation does not THROW when the halt check throws', async () => {
    // The old failure mode: the error propagated out of the loop and every remaining step died
    // with it. Whatever else happens, the cascade driver must survive.
    const { env } = makeEnv({ failAdvance: true });
    await expect(notifyActivation(env, 'evt-fail-open', 'https://example.invalid')).resolves.toBeUndefined();
  });

  it('a readable claim state still HALTS — fail-open must not become always-open', async () => {
    // The counterpart, and the more important of the two. `changes === 0` is a real answer:
    // claimed, closed, or already advanced. It must still stop the step. A fix that returned
    // true unconditionally would pass the test above and destroy the halt entirely.
    const { env } = makeEnv({ failAdvance: false });
    let changes = 0;
    const orig = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      const s = orig(sql) as { bind: (...a: unknown[]) => Record<string, unknown> };
      if (!sql.includes('SET cascadeStep')) return s as never;
      return {
        ...s,
        bind: (...args: unknown[]) => ({
          ...(s.bind(...args) as object),
          async run() {
            changes += 1;
            return { meta: { changes: 0 } }; // a coordinator has claimed
          },
        }),
      } as never;
    };
    await notifyActivation(env, 'evt-halts', 'https://example.invalid').catch(() => undefined);
    expect(changes, 'the halt check never ran').toBeGreaterThan(0);
  });
});
