import { describe, expect, it } from 'vitest';

import { verifyChain } from '../src/lib/chain-verdict';

/**
 * Brief 37 Fix A — a check that passes because there was nothing to check.
 *
 * `GET /v1/admin/events/<any-uuid>/chain` answered `VERIFIED — no records to verify` for an id
 * that never existed. An operator asking "is this event's custody intact?" about a typo, a stale
 * link, or a fabricated id was told yes. Two distinct absences were being reported as a positive
 * finding: no such event, and no records for a real one.
 */
const stub = (opts: { eventExists: boolean; records?: unknown[]; head?: unknown; audit?: unknown }) =>
  ({
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (/FROM events WHERE id/.test(sql)) return opts.eventExists ? { present: 1 } : null;
            if (/audit_log/.test(sql)) return opts.audit ?? null;
            return opts.head ?? null;
          },
          async all() {
            return { results: opts.records ?? [] };
          },
        };
      },
    },
  }) as never;

describe('an absent subject is not a verified one', () => {
  it('a nonexistent event is EVENT_NOT_FOUND, never VERIFIED', async () => {
    const v = await verifyChain(stub({ eventExists: false }), 'does-not-exist');
    expect(v.outcome).toBe('EVENT_NOT_FOUND');
    expect(v.detail).toMatch(/nothing to verify/);
  });

  it('a real event with zero records is NO_RECORDS, never VERIFIED', async () => {
    // "Nothing happened" is true and useful. "The custody chain is intact" is a different claim,
    // and an empty set is not evidence for it.
    const v = await verifyChain(stub({ eventExists: true, records: [] }), 'real-but-empty');
    expect(v.outcome).toBe('NO_RECORDS');
    expect(v.records).toBe(0);
  });

  it('VERIFIED is no longer reachable with zero records', async () => {
    for (const exists of [true, false]) {
      const v = await verifyChain(stub({ eventExists: exists, records: [] }), 'x');
      expect(v.outcome, `records=0 exists=${exists}`).not.toBe('VERIFIED');
    }
  });
});
