import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { seatCeilingReached } from '../src/lib/org';

/**
 * Brief 23 §4 — Purchase (license record + seat ceiling). Structural only: a license
 * is a RECORD; no payment processing, no checkout, no sponsor/funder entity exists,
 * and org_pubkey is a reserved forward hook with no crypto behind it this brief.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, '..', p), 'utf8');

describe('§4 seat ceiling rule (pure)', () => {
  it('admits a survivor while seats remain', () => {
    expect(seatCeilingReached({ seatsTotal: 5, seatsUsed: 4 })).toBe(false);
  });
  it('refuses once used has reached total', () => {
    expect(seatCeilingReached({ seatsTotal: 5, seatsUsed: 5 })).toBe(true);
    expect(seatCeilingReached({ seatsTotal: 5, seatsUsed: 6 })).toBe(true);
  });
  it('a zero-seat license admits no survivor', () => {
    expect(seatCeilingReached({ seatsTotal: 0, seatsUsed: 0 })).toBe(true);
  });
});

describe('§4 no payment processing exists (record only)', () => {
  // Strip comments first: disclaimers like "no checkout, no card" legitimately name
  // the banned terms in prose — what must be absent is payment/sponsor CODE.
  const stripJs = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
  const orgCode = stripJs(read('src/lib/org.ts'));
  const migrationCode = stripSql(read('migrations/0031_org_tenancy.sql'));

  it('the org tenancy code carries no checkout/card/payment machinery', () => {
    const banned = /\b(stripe|checkout|charge|card|payment|paypal|braintree)\b/i;
    expect(orgCode).not.toMatch(banned);
    expect(migrationCode).not.toMatch(banned);
  });

  it('has no sponsor / funder / seat-gifting entity (out of scope)', () => {
    const sponsor = /\b(sponsor|funder|donation|gift)\b/i;
    expect(orgCode).not.toMatch(sponsor);
    expect(migrationCode).not.toMatch(sponsor);
  });
});

describe('§4/[A] org_pubkey is a reserved, unused forward hook (zero crypto)', () => {
  const org = read('src/lib/org.ts');

  it('createOrg writes org_pubkey as null and never derives or uses a key', () => {
    expect(org).toMatch(/orgPubkey: null/);
    // No crypto operation is performed on org_pubkey anywhere in the tenancy lib.
    expect(org).not.toMatch(/orgPubkey[\s\S]{0,40}(sign|encrypt|decrypt|verify|importKey)/i);
  });
});
