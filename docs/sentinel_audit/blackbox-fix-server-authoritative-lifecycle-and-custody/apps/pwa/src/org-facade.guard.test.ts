import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 23 §6 — org tenancy guards.
 *
 * §0a: NOTHING about org membership, enrollment, coordination, seats, or licensing
 * ever appears in the survivor's Hidden facade — it must stay byte-identical whether
 * or not the account belongs to an org. An "org" tell on the covert screen is exactly
 * the kind of leak the facade exists to prevent.
 *
 * No payment surface, price, or fee is ever rendered inside a survivor account, and
 * the org portal itself shows no price (lane is a label, never a charge).
 *
 * Coordinator role/enrollment actions fire only on explicit interaction, never on
 * page load / a passive GET — an automated link scanner must not enroll or claim.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const ORG_WORDS = /enrollment|coordinator|organisation|organization|\bseats?\b|licen[cs]e|org portal|orgId|orgRole/i;
// "zero-fee" / "zero_fee" is the brief-mandated lane LABEL, not a charge — exclude it
// from the fee match; everything else payment-shaped is still caught.
const PAYMENT = /\$\s?\d|\bprice\b|(?<!zero[-_])\bfees?\b|\binvoice\b|\bcheckout\b|\bcredit card\b|\bbilling\b/i;

describe('§0a the Hidden facade shows nothing about orgs', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface renders org / enrollment / seat / license wording', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not mention orgs`).not.toMatch(ORG_WORDS);
    }
  });

  it('no facade surface imports or links the org portal', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not reference the org portal`).not.toMatch(/OrgPortal|OrgSignIn|['"]\/org['"]/);
    }
  });
});

describe('§6 no payment surface, price, or fee in any survivor surface', () => {
  // Strip comments: a doc comment saying "shows NO price or fee" legitimately names
  // the terms — what must be absent is a rendered price/fee, i.e. in the CODE/JSX.
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const survivorSurfaces = [
    './routes/settings/Settings.tsx',
    './routes/blackbox/BlackBoxHome.tsx',
    './components/ContactForm.tsx',
    './routes/onboarding/Onboarding.tsx',
    './routes/meditation/MeditationHome.tsx',
  ];

  it('no survivor surface renders a price / fee / billing element', () => {
    for (const f of survivorSurfaces) {
      const src = stripComments(read(f));
      expect(src, `${f} must render no payment surface`).not.toMatch(PAYMENT);
    }
  });

  it('the org portal itself shows no price (lane is a label, not a charge)', () => {
    expect(stripComments(read('./routes/org/OrgPortal.tsx'))).not.toMatch(PAYMENT);
  });
});

describe('§6 org actions fire only on explicit interaction, never on page load', () => {
  const portal = read('./routes/org/OrgPortal.tsx');

  it('issuing an enrollment code is a click, not an on-mount effect', () => {
    expect(portal).toMatch(/onClick=\{\(\) => void issue\(\)\}/);
    // issue() must not be invoked from a useEffect (no passive/auto enrollment).
    expect(portal).not.toMatch(/useEffect\([\s\S]{0,120}\bissue\(/);
  });

  it('removing a seat is a click on an explicit control', () => {
    expect(portal).toMatch(/onClick=\{\(\) => void remove\(s\.userId\)\}/);
  });
});
