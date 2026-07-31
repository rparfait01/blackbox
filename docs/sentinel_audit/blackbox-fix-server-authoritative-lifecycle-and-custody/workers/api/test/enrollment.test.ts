import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeRedeemable } from '../src/lib/enrollment';

/**
 * Brief 23 §3 — Distribution (enroll + migration + reversal). The redeemability rule
 * is pure and fully enumerated here; the seat/binding races are atomic DB steps
 * proven live in the acceptance suite. Source guards pin that a code grants membership
 * only (org from the code, never data access) and that survivor enroll is atomic.
 */

const valid = { revoked: 0, expiresAt: null, maxUses: 1, usedCount: 0 };
const now = 1_000_000;

describe('§3 code redeemability (pure) — every rejection path', () => {
  it('a fresh, unexpired, unused code is redeemable', () => {
    expect(codeRedeemable(valid, now)).toEqual({ ok: true });
  });
  it('a missing code is not_found', () => {
    expect(codeRedeemable(null, now)).toEqual({ ok: false, reason: 'not_found' });
  });
  it('a revoked code is refused', () => {
    expect(codeRedeemable({ ...valid, revoked: 1 }, now)).toEqual({ ok: false, reason: 'revoked' });
  });
  it('an expired code is refused (expiry at/*before* now)', () => {
    expect(codeRedeemable({ ...valid, expiresAt: now }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(codeRedeemable({ ...valid, expiresAt: now - 1 }, now)).toEqual({ ok: false, reason: 'expired' });
  });
  it('a code at its use limit is exhausted', () => {
    expect(codeRedeemable({ ...valid, maxUses: 2, usedCount: 2 }, now)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });
  it('a still-valid future expiry with uses left is redeemable', () => {
    expect(codeRedeemable({ revoked: 0, expiresAt: now + 1, maxUses: 5, usedCount: 4 }, now)).toEqual({
      ok: true,
    });
  });
});

describe('§3 enrollment binds membership, not data access; seats are atomic', () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(SRC, '../src/lib/enrollment.ts'), 'utf8');

  it('survivor enroll reserves a seat with an atomic conditional UPDATE (no ceiling race)', () => {
    expect(src).toMatch(/UPDATE org_licenses SET seatsUsed = seatsUsed \+ 1[\s\S]*seatsUsed < seatsTotal/);
    expect(src).toMatch(/seats_full/);
  });

  it('redeem consumes a use atomically and rolls it back if the bind is refused', () => {
    expect(src).toMatch(/UPDATE enrollment_codes SET usedCount = usedCount \+ 1[\s\S]*usedCount < maxUses/);
    expect(src).toMatch(/usedCount = usedCount - 1/); // give the use back on refusal
  });

  it('leaving frees only a survivor seat and never goes negative; history is preserved', () => {
    expect(src).toMatch(/MAX\(0, seatsUsed - 1\)/);
    expect(src).toMatch(/UPDATE users SET orgId = NULL/);
    // Past events are NOT rewritten on leave — the stamped org stays frozen.
    expect(src).not.toMatch(/UPDATE events SET orgId/);
  });
});
