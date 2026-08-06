import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

// @ts-expect-error -- .mjs guard helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';
import { runEscalation } from '../src/lib/closure-timeout';
import type { Env } from '../src/types';

/**
 * P0 — THE ESCALATION THAT RE-ARMED THE CASCADE ON A COORDINATED EVENT.
 *
 * Live incident 93ebe889, from the audit trail:
 *
 *     7.7s   coordinator_claimed
 *    88.4s   user_assent                  (she requested closure)
 *   307.0s   coordinator_path_failed      <- this branch
 *   315.0s   cascade_fired                <- THE CASCADE RESUMED
 *   316.4s   notification_delivered_email <- the secondary was told nobody had responded
 *   341.7s   coordinator_claimed          <- the secondary took coordination on a claimed event
 *
 * The cause was one column in one UPDATE: the fail branch set `coordinatorClaimedAt = NULL`, and
 * the cascade halt is `WHERE coordinatorClaimedAt IS NULL`. Escalating the CONFIRMER TIER is not
 * the same as nobody having responded, and it must not restart NOTIFICATION.
 *
 * Behavioural, per the standing rule: a guard could assert the column is absent from the SQL and
 * pass on an implementation that nulls it in a second statement.
 */
function envCapturing(rows: Array<Record<string, unknown>>): { env: Env; statements: string[] } {
  const statements: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        return {
          bind: () => ({
            async run() {
              return { meta: { changes: 1 } };
            },
            async all() {
              return { results: sql.includes('FROM events') ? rows : [] };
            },
            async first() {
              return sql.includes("role = 'guardian'") ? { x: 1 } : null;
            },
          }),
          async run() {
            return { meta: { changes: 1 } };
          },
          // runEscalation calls .all() directly on prepare(), with no .bind() — the row set has
          // to be reachable from BOTH shapes or the fail branch never runs and the test passes
          // over nothing. The subject assertion below is what caught that.
          async all() {
            return { results: sql.includes('FROM events') ? rows : [] };
          },
          async first() {
            return null;
          },
        };
      },
    },
  } as unknown as Env;
  return { env, statements };
}

/** An event whose closure request is old enough to have failed the coordinator path. */
const FAILED_ROW = {
  id: 'evt-1',
  userId: 'u1',
  status: 'active',
  escalationTier: 'coordinator',
  closeRequestStatus: 'sat',
  closeRequestedAt: Date.now() - 10 * 60 * 1000,
  tamperingAt: null,
  closureRepromptAt: Date.now() - 9 * 60 * 1000,
  coordinatorPathFailedAt: null,
};

describe('the coordinator-path failure does not un-claim the event', () => {
  it('NEVER writes coordinatorClaimedAt = NULL', async () => {
    const { env, statements } = envCapturing([FAILED_ROW]);
    await runEscalation(env, 'https://example.invalid');
    const update = statements.find((s) => s.startsWith('UPDATE events SET coordinatorPathFailedAt'));
    expect(update, 'the fail branch never ran — this test asserts over nothing').toBeDefined();
    expect(
      update,
      'un-claiming the event re-arms the contact cascade: the halt is WHERE coordinatorClaimedAt IS NULL',
    ).not.toMatch(/coordinatorClaimedAt\s*=\s*NULL/);
    expect(update, 'the coordinator key must survive with the claim').not.toMatch(/coordinatorKey\s*=\s*NULL/);
  });

  it('still records the tier change and still clears the SURVIVOR assent', async () => {
    // The guardian is a new confirmer and consent does not transfer between confirmers. What
    // changed is only that she can now ask again — see ClosureControl.
    const { env, statements } = envCapturing([FAILED_ROW]);
    await runEscalation(env, 'https://example.invalid');
    const update = statements.find((s) => s.startsWith('UPDATE events SET coordinatorPathFailedAt'));
    expect(update).toMatch(/escalationTier\s*=\s*\?/);
    expect(update).toMatch(/closeRequestStatus\s*=\s*NULL/);
    expect(update).toMatch(/supportAssentAt\s*=\s*NULL/);
  });

  it('a fresh claim is still possible after the path fails', async () => {
    // The guardian must be able to take over. With the claim no longer nulled, the claim route
    // has to admit a re-claim on coordinatorPathFailedAt instead.
    // Comment-stripped via the sanctioned helper: the property is the SQL predicate, which is a
    // string literal, so text is the right tool — but it must not be satisfiable by a comment.
    const index = code(fileURLToPath(new URL('../src/index.ts', import.meta.url))) as string;
    expect(index).toMatch(/coordinatorClaimedAt IS NULL OR coordinatorPathFailedAt IS NOT NULL/);
  });
});
