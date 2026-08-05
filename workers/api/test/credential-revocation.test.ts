import { describe, expect, it } from 'vitest';

import {
  REPLAY_SAFE,
  SPENT_CREDENTIAL_RETENTION_MS,
  purgeExpiredCredentials,
  revokeEventCredentials,
  sweepClosedEventCredentials,
} from '../src/lib/credential-revocation';
import { CAPABILITY_TTL_MS } from '../src/lib/signup-capability';
import type { Env } from '../src/types';

/**
 * BRIEF 57 — A COORDINATOR CREDENTIAL EXISTS FOR THE DURATION OF A LIVE EVENT.
 *
 * Behavioural, per the ratified rule: a guard could assert that a DELETE statement mentions
 * `coordinator_view_sessions` and pass on an implementation that never runs it, or that runs it
 * and also deletes the audit log. What matters is which statements execute and which tables they
 * name.
 */
function recordingEnv(rows: Array<{ id: string }> = []): { env: Env; sql: string[] } {
  const sql: string[] = [];
  const env = {
    DB: {
      prepare(q: string) {
        sql.push(q.replace(/\s+/g, ' ').trim());
        return {
          bind: () => ({
            async run() {
              return { meta: { changes: 1 } };
            },
            async all() {
              return { results: rows };
            },
            async first() {
              return null;
            },
          }),
          async run() {
            return { meta: { changes: 1 } };
          },
          async all() {
            return { results: rows };
          },
          async first() {
            return null;
          },
        };
      },
    },
  } as unknown as Env;
  return { env, sql };
}

/** Tables that are EVIDENCE. No cleanup path may name any of them, at any age. */
const EVIDENCE_TABLES = [
  'audit_log',
  'delivery_records',
  'closure_reports',
  'chunks_index',
  'integrity_records',
  'integrity_heads',
  'locations_index',
  'transcripts_index',
  'classifications_index',
  'vault_objects',
];

describe('revocation kills the credential and nothing else', () => {
  it('deletes the view session and marks the event revoked', async () => {
    const { env, sql } = recordingEnv();
    const r = await revokeEventCredentials(env, 'evt-1');
    expect(sql.some((q) => q.startsWith('DELETE FROM coordinator_view_sessions'))).toBe(true);
    expect(sql.some((q) => q.includes('SET credentialsRevokedAt'))).toBe(true);
    expect(r.revoked).toBe(true);
  });

  it('the revocation is recorded as a custody fact', async () => {
    // It bounds the window in which anyone could have opened this event, which is a question an
    // evidence review may ask.
    const { env, sql } = recordingEnv();
    await revokeEventCredentials(env, 'evt-1');
    expect(sql.some((q) => q.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('NEVER touches evidence — this is the line the whole design rests on', async () => {
    const { env, sql } = recordingEnv();
    await revokeEventCredentials(env, 'evt-1');
    await purgeExpiredCredentials(env, 1_800_000_000_000);
    await sweepClosedEventCredentials(env);
    const destructive = sql.filter((q) => q.startsWith('DELETE') || q.startsWith('UPDATE'));
    for (const table of EVIDENCE_TABLES) {
      for (const q of destructive) {
        expect(q, `a cleanup statement targets ${table}: ${q}`).not.toMatch(
          new RegExp(`(DELETE FROM|UPDATE)\\s+${table}\\b`),
        );
      }
    }
  });

  it('a failure to revoke never propagates — closing the alert is what matters', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    await expect(revokeEventCredentials(env, 'evt-1')).resolves.toEqual({ sessions: 0, revoked: false });
  });
});

describe('the sweep is the backstop for the five terminal writers', () => {
  it('finds closed events that still hold credentials', async () => {
    const { env, sql } = recordingEnv([{ id: 'a' }, { id: 'b' }]);
    const n = await sweepClosedEventCredentials(env);
    expect(n).toBe(2);
    expect(sql.some((q) => q.includes("status != 'active' AND credentialsRevokedAt IS NULL"))).toBe(true);
  });

  it('reclaims sessions whose event no longer exists at all', async () => {
    const { env, sql } = recordingEnv();
    await sweepClosedEventCredentials(env);
    expect(sql.some((q) => q.includes('eventId NOT IN (SELECT id FROM events)'))).toBe(true);
  });
});

describe('the purge only names credential stores', () => {
  it('covers every single-use credential table', async () => {
    const { env, sql } = recordingEnv();
    const counts = await purgeExpiredCredentials(env, 1_800_000_000_000);
    for (const t of [
      'otp_codes',
      'password_resets',
      'webauthn_challenges',
      'account_magic_links',
      'consumed_capabilities',
      'line_pairings',
    ]) {
      expect(sql.some((q) => q.includes(`DELETE FROM ${t}`)), `${t} is not swept`).toBe(true);
      expect(counts).toHaveProperty(t);
    }
  });

  it('a missing table degrades to -1 rather than failing the whole sweep', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind: () => ({
              async run() {
                throw new Error('no such table');
              },
            }),
          };
        },
      },
    } as unknown as Env;
    const counts = await purgeExpiredCredentials(env, 1_800_000_000_000);
    expect(Object.values(counts).every((v) => v === -1)).toBe(true);
  });
});

describe('a connected pairing is a RECORD, not a spent credential', () => {
  it('the sweep only removes pairings that were never connected', async () => {
    // A connected pairing is expired too — expiresAt was stamped when the nonce was minted. The
    // first version of this sweep deleted those, destroying the record of who connected a LINE
    // contact and when: the same shape as an enrollment redemption. Delivery was never at risk
    // (the live address lives in contact_endpoints), but the enrollment record was.
    const { env, sql } = recordingEnv();
    await purgeExpiredCredentials(env, 1_800_000_000_000);
    const stmt = sql.find((q) => q.includes('DELETE FROM line_pairings'));
    expect(stmt).toBeDefined();
    expect(stmt, 'a connected pairing would be deleted').toContain("status != 'connected'");
    expect(stmt).toContain('connectedAt IS NULL');
  });

  it('enrollment_codes is never named by any cleanup statement', async () => {
    // A record, permanently. Its USABILITY is swept at redemption instead — see below.
    const { env, sql } = recordingEnv();
    await purgeExpiredCredentials(env, 1_800_000_000_000);
    await sweepClosedEventCredentials(env);
    await revokeEventCredentials(env, 'e');
    expect(sql.some((q) => /(DELETE FROM|UPDATE)\s+enrollment_codes/.test(q))).toBe(false);
  });
});

describe('consumed_capabilities is replay prevention, not a leftover', () => {
  it('retention outlives the capability by a wide margin', () => {
    // Deleting a consumed jti while its capability is still signature-valid re-opens Brief 30
    // Fix A — `signupId` was a live account takeover. The two constants live in different files,
    // so the relationship is asserted rather than assumed: raise the TTL past the retention and
    // this fails BEFORE the replay window opens.
    expect(REPLAY_SAFE, 'the purge would delete a jti that can still be replayed').toBe(true);
    expect(SPENT_CREDENTIAL_RETENTION_MS).toBeGreaterThan(CAPABILITY_TTL_MS * 2);
  });
});
