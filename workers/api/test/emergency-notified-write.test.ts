import { describe, expect, it } from 'vitest';

import { listCascadeContacts } from '../src/lib/contacts';
import type { Env } from '../src/types';

/**
 * BRIEF 56 — A COLUMN THAT WAS READ AND NEVER WRITTEN.
 *
 * `events.emergencyNotifiedAt` is declared in migration 0015 and referenced in exactly one place:
 * the WHERE clause of `closeFeedLostEvents`, the 90-second close for a capture that physically
 * stopped — a phone seized, smashed, or out of battery. Nothing set it. On production, 0 of 16
 * events carried a value, so that close had never executed and could not, and the
 * abnormal-termination declaration (Brief 38 §D) and seal enqueue (Brief 40 §F1) that hang off it
 * never ran either. Those are the terminations that matter MOST.
 *
 * A dead safety path reads exactly like a live one from the outside, which is why this is
 * asserted at the point the value is produced rather than at the point it is consumed.
 */
function envWith(rows: Array<Record<string, unknown>>, emergency: Record<string, unknown> | null): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            async first() {
              if (sql.includes('guardianEnabled')) return { guardianEnabled: 1 };
              if (sql.includes("role = 'emergency'")) return emergency;
              return null;
            },
            async all() {
              return { results: sql.includes('FROM contacts') ? rows : [] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
  } as unknown as Env;
}

const CONTACTS = [
  { id: 'c1', displayName: 'Primary', role: 'contact', status: 'confirmed' },
  { id: 'c2', displayName: 'Guardian', role: 'guardian', status: 'confirmed' },
];

describe('the emergency rung identifies itself', () => {
  it('the final rung is MARKED, so the dispatcher can tell which step it is firing', () => {
    // Without this the dispatcher saw an indistinguishable list of {id, displayName} and had no
    // way to know it had reached the end of the chain — which is why the column was never set.
    const env = envWith(CONTACTS, { id: 'c9', displayName: 'Emergency' });
    return listCascadeContacts(env, { userId: 'u1', userHash: null }).then((list) => {
      expect(list).toHaveLength(3);
      expect(list[2]).toMatchObject({ id: 'c9', isEmergency: true });
      // …and ONLY the last one. Marking an ordinary contact would make an early step write the
      // column and arm a 90-second close over a live, healthy capture.
      expect(list[0]).not.toHaveProperty('isEmergency', true);
      expect(list[1]).not.toHaveProperty('isEmergency', true);
    });
  });

  it('an account with no emergency contact yields no marked rung', () => {
    // The current production shape: contact -> guardian, and nothing after it. The cascade must
    // not claim to have reached a rung that does not exist.
    const env = envWith(CONTACTS, null);
    return listCascadeContacts(env, { userId: 'u1', userHash: null }).then((list) => {
      expect(list).toHaveLength(2);
      expect(list.some((c) => c.isEmergency)).toBe(false);
    });
  });
});
