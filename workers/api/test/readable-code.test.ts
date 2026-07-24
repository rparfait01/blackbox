import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateReadableCode, groupCode, normalizeCode } from '../src/lib/readable-code';
import { redeemRateDecision, REDEEM_MAX_ATTEMPTS, REDEEM_WINDOW_MS } from '../src/lib/enrollment';

/**
 * Brief 28 §4 — the ONE readable-code generator + the redemption rate limit (pure).
 * The seat/binding/normalization DB races are proven live in the acceptance suite;
 * here the format + rate rule are fully enumerated, and a guard proves recovery + org
 * codes share this one generator (no second, weaker implementation).
 */

describe('§4 the readable alphabet has no confusable characters', () => {
  it('never emits 0/O, 1/I/L, or U — across many samples', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateReadableCode(10);
      expect(code).toHaveLength(10);
      // The alphabet is Crockford base32 minus I,L,O,U. O/I/L/U must never appear.
      expect(code).not.toMatch(/[ILOU]/);
      // Only alphabet characters.
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    }
  });

  it('normalize + group round-trips: display form redeems to the stored form', () => {
    const stored = generateReadableCode(10);
    const shown = groupCode(stored, 4); // what a coordinator reads aloud
    expect(shown.replace(/-/g, '')).toBe(stored);
    // However the survivor types it — lower-case, spaced, dashed — it normalizes back.
    expect(normalizeCode(shown.toLowerCase())).toBe(stored);
    expect(normalizeCode(`  ${shown}  `)).toBe(stored);
    expect(normalizeCode(stored)).toBe(stored); // already canonical
  });
});

describe('§4 redemption rate limit (pure) — brute-force guard on short codes', () => {
  const now = 10_000_000;

  it('a fresh account (no window) is allowed and opens a window', () => {
    expect(redeemRateDecision({ redeemWindowStart: null, redeemAttempts: 0 }, now)).toEqual({
      allowed: true,
      windowStart: now,
      attempts: 1,
    });
  });

  it('within the window, attempts accumulate until the ceiling', () => {
    const v = redeemRateDecision({ redeemWindowStart: now, redeemAttempts: 3 }, now + 1000);
    expect(v).toEqual({ allowed: true, windowStart: now, attempts: 4 });
  });

  it('at the ceiling it is refused', () => {
    expect(
      redeemRateDecision({ redeemWindowStart: now, redeemAttempts: REDEEM_MAX_ATTEMPTS }, now + 1000),
    ).toEqual({ allowed: false });
  });

  it('a lapsed window resets the count and opens a fresh window', () => {
    const v = redeemRateDecision(
      { redeemWindowStart: now, redeemAttempts: REDEEM_MAX_ATTEMPTS },
      now + REDEEM_WINDOW_MS + 1,
    );
    expect(v).toEqual({ allowed: true, windowStart: now + REDEEM_WINDOW_MS + 1, attempts: 1 });
  });
});

describe('§4 ONE code generator — recovery + org codes share it (no second impl)', () => {
  const ROOT = dirname(fileURLToPath(import.meta.url));
  const read = (p: string): string => readFileSync(join(ROOT, '..', p), 'utf8');

  it('recovery, enrollment, and registration codes all use generateReadableCode', () => {
    expect(read('src/lib/recovery-code.ts')).toMatch(/generateReadableCode/);
    expect(read('src/lib/org.ts')).toMatch(/generateReadableCode/);
    expect(read('src/lib/org-registration.ts')).toMatch(/generateReadableCode/);
  });

  it('the old 128-bit hex generator is gone from the code-minting paths', () => {
    expect(read('src/lib/org.ts')).not.toMatch(/randomHex/);
    expect(read('src/lib/org-registration.ts')).not.toMatch(/randomHex/);
  });
});
