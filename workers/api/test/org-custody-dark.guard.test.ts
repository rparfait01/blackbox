import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  darkRefusal,
  logCaptureAccess,
  orgCustodyArmed,
  recordRelease,
  recordRotation,
  storeWrappedLocation,
  watermarkFor,
} from '../src/lib/org-custody';
import type { Env } from '../src/types';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * SQL line/block comments.
 *
 * `guard-source.mjs` strips JS comments and would leave `--` lines intact — so a comment
 * describing the coordinate columns this table does NOT have would satisfy the assertion below.
 * A guard passing on a comment is exactly the failure that rule exists for, and SQL needs its own
 * stripper rather than the JS one.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Brief 53 §C — ORG CUSTODY IS DARK, AND FAILS CLOSED.
 *
 * Brief 26 §5 requires an independent crypto review and a legal review of chain of custody. Both
 * are UNMET. This guard is what stops the flag drifting on before they clear — not because a flag
 * flip is likely to be malicious, but because "it was already built and the tests were green" is
 * how unreviewed cryptography reaches a survivor's evidence.
 *
 * ═══ THE FLAG DIRECTION IS THE OPPOSITE OF THE CAPTURE PATH, ON PURPOSE ═══════════════════════
 *
 * Everything on the capture path fails OPEN: a survivor mid-incident must keep recording even if
 * a control is broken, because lost evidence is the harm the system exists to prevent. This fails
 * CLOSED. Releasing a survivor's evidence to a third party on an unreviewed crypto design is not
 * a mitigation that failed — it IS the harm. A rule that reads "fail open" without asking what
 * fails open into is a rule applied by rote.
 */

/** A D1 stand-in that records statements and would throw if the dark path ever wrote. */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  const writes: string[] = [];
  const stmt = {
    bind: () => stmt,
    run: async () => {
      writes.push('run');
      return { success: true };
    },
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  return {
    DB: { prepare: (sql: string) => { writes.push(sql); return stmt; } },
    __writes: writes,
    ...overrides,
  } as unknown as Env;
}

describe('Brief 53 §C — org custody ships dark', () => {
  it('is OFF when the binding is absent', () => {
    expect(orgCustodyArmed(fakeEnv())).toBe(false);
  });

  it('is OFF for every value that is not exactly "true"', () => {
    // An unset binding and an explicit 'false' must behave identically, and a typo must not arm
    // it. `Boolean(env.X)` would arm on 'false', 'no', and '0' — all of which read as "off".
    for (const value of ['false', 'FALSE', '0', 'no', 'off', '', '   ', 'yes', 'True ', 'enabled']) {
      const armed = orgCustodyArmed(fakeEnv({ ORG_CUSTODY_ENABLED: value } as Partial<Env>));
      expect(armed, `ORG_CUSTODY_ENABLED=${JSON.stringify(value)} armed org custody`).toBe(
        value.trim().toLowerCase() === 'true',
      );
    }
  });

  it('arms ONLY on the exact string, so the guard is a bound and not an outage', () => {
    expect(orgCustodyArmed(fakeEnv({ ORG_CUSTODY_ENABLED: 'true' } as Partial<Env>))).toBe(true);
    expect(orgCustodyArmed(fakeEnv({ ORG_CUSTODY_ENABLED: ' TRUE ' } as Partial<Env>))).toBe(true);
  });

  it('every operation REFUSES while dark — never a quiet success, never a silent no-op', async () => {
    const env = fakeEnv();
    const results = [
      await recordRotation(env, {
        orgId: 'o', fromGeneration: 0, toGeneration: 1, reason: 'seat_offboarded',
        performedBySeatId: 's', departedSeatId: 'd', seatsRewrapped: 2, signature: null, signatureAlgId: null,
      }),
      await recordRelease(env, {
        eventId: 'e', orgId: 'o', authorizedByUserId: 'u', recipientLabel: 'court',
        recipientPubkey: 'k', algId: 'a', purpose: null, wrappedDek: 'w', expiresAt: null,
      }),
      await logCaptureAccess(env, {
        eventId: 'e', sequence: 0, orgId: 'o', seatUserId: 's', keyGeneration: 0, accessKind: 'decrypt',
      }),
      await storeWrappedLocation(env, {
        eventId: 'e', sequence: 0, orgId: 'o', algId: 'a', iv: 'i', ciphertext: 'c', recordedAt: 1,
      }),
    ];
    for (const r of results) {
      expect(r.ok, 'a dark operation reported success').toBe(false);
      expect(r.refusal, 'the refusal is unnamed — a caller cannot tell dark from broken').toBe('dark_pending_review');
      expect(r.detail, 'the refusal does not say the reviews are the gate').toMatch(/review/i);
    }
    // Nothing was written. A "refusal" that still inserts is not a refusal.
    expect((env as unknown as { __writes: string[] }).__writes, 'the dark path wrote to D1').toEqual([]);
  });

  it('the refusal names BOTH §C4 gates, so nobody has to go looking for why', () => {
    const detail = darkRefusal().detail ?? '';
    expect(detail).toMatch(/crypto review/i);
    expect(detail).toMatch(/legal review|admissib/i);
  });

  it('§C5.4 — a release requires the SURVIVOR, not a seat with every console permission', async () => {
    // Armed, so this exercises the authorization rather than the flag. The event's owner is
    // 'survivor'; a seat authorizing on her behalf must be refused.
    const env = {
      ORG_CUSTODY_ENABLED: 'true',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ success: true }),
            first: async () => ({ userId: 'survivor' }),
          }),
        }),
      },
    } as unknown as Env;

    const bySeat = await recordRelease(env, {
      eventId: 'e', orgId: 'o', authorizedByUserId: 'seat_with_admin_rights', recipientLabel: 'court',
      recipientPubkey: 'k', algId: 'a', purpose: null, wrappedDek: 'w', expiresAt: null,
    });
    expect(bySeat.ok, 'a seat released a survivor’s evidence').toBe(false);
    expect(bySeat.refusal).toBe('not_authorized');

    const byOwner = await recordRelease(env, {
      eventId: 'e', orgId: 'o', authorizedByUserId: 'survivor', recipientLabel: 'court',
      recipientPubkey: 'k', algId: 'a', purpose: null, wrappedDek: 'w', expiresAt: null,
    });
    expect(byOwner.ok, 'the owner could not release her own evidence — checked both ways').toBe(true);
  });

  it('§C2 — a rotation must ADVANCE the generation', async () => {
    const env = fakeEnv({ ORG_CUSTODY_ENABLED: 'true' } as Partial<Env>);
    const base = {
      orgId: 'o', reason: 'seat_offboarded' as const, performedBySeatId: 's',
      departedSeatId: 'd', seatsRewrapped: 2, signature: null, signatureAlgId: null,
    };
    // A non-advancing rotation leaves the departed seat's grant valid at the current generation —
    // the exact failure offboarding exists to prevent — while reading as a successful rotation.
    for (const [from, to] of [[3, 3], [3, 2]]) {
      const r = await recordRotation(env, { ...base, fromGeneration: from, toGeneration: to });
      expect(r.ok, `rotation ${from} → ${to} was accepted`).toBe(false);
      expect(r.refusal).toBe('invalid_input');
    }
    expect((await recordRotation(env, { ...base, fromGeneration: 3, toGeneration: 4 })).ok).toBe(true);
  });

  it('the watermark carries what a leak investigation walks backwards', () => {
    const w = watermarkFor({ eventId: 'evt1', orgId: 'org1', seatUserId: 'seat1', keyGeneration: 2, at: 1700000000000 });
    for (const part of ['org1', 'seat1', 'evt1', 'g2']) {
      expect(w, `watermark omits ${part} — a leaked file would not name its reader`).toContain(part);
    }
    // An unaffiliated survivor's capture still watermarks; it simply names no org.
    expect(watermarkFor({ eventId: 'e', orgId: null, seatUserId: 's', keyGeneration: null, at: 1 })).toContain('noorg');
  });

  it('wrapped_locations has NO plaintext coordinate column', () => {
    // Decision B — the point is unrepresentable in plaintext in this table. A lat/lon column here
    // would make "wrapped" a description of intent rather than of the schema.
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, '0061_org_custody.sql'), 'utf8'));
    const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS wrapped_locations'));
    const body = block.slice(0, block.indexOf(');'));
    expect(body, 'the fixture moved — wrapped_locations not found').toContain('ciphertext');
    expect(/\b(lat|lon|latitude|longitude|accuracy)\b/i.test(body), 'a plaintext coordinate column exists').toBe(false);
  });
});
