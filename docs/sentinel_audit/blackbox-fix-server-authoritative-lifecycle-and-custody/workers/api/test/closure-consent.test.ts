import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decideConsent, isSupportEngaged, type ConsentState } from '../src/lib/closure-consent';

/**
 * Brief 0B — consent scales to the parties actually ENGAGED. This behavior had
 * ZERO guard coverage before; per the brief it must not ship without it. These
 * pin the MODEL: the required-consent set is derived from event state, never
 * hardcoded to two, and anti-coercion holds the instant a responder is present.
 */

// A solo, unclaimed, un-notified-engaged event with the survivor's clean gesture in.
const base: ConsentState = {
  status: 'active',
  closeRequestStatus: 'sat',
  supportAssentAt: null,
  coordinatorClaimedAt: null,
  tamperingAt: null,
};

describe('Brief 0B §1 — engagement is an explicit action, not delivery', () => {
  it('no coordinator claim and no assent = not engaged', () => {
    expect(isSupportEngaged({ coordinatorClaimedAt: null, supportAssentAt: null })).toBe(false);
  });
  it('a coordinator claim (link opened, human present) = engaged', () => {
    expect(isSupportEngaged({ coordinatorClaimedAt: 123, supportAssentAt: null })).toBe(true);
  });
  it('a submitted support assent = engaged', () => {
    expect(isSupportEngaged({ coordinatorClaimedAt: null, supportAssentAt: 123 })).toBe(true);
  });
});

describe('Brief 0B — the deadlock class is gone: a present survivor closes alone', () => {
  it('solo + user assented → closes solo (no wait, no awaiting_support)', () => {
    expect(decideConsent(base)).toBe('close_solo');
  });

  it('notified-but-not-engaged is still solo (delivery is not engagement)', () => {
    // The common 3 a.m. case: contacts were texted but nobody opened. No engagement
    // field is set, so the survivor is still solo and closes alone.
    expect(decideConsent({ ...base })).toBe('close_solo');
  });

  it('a solo DURESS close still closes (disposition recorded, not blocked)', () => {
    expect(decideConsent({ ...base, closeRequestStatus: 'unsat' })).toBe('close_solo');
  });

  it('no user gesture yet → awaiting_user (survivor assent is always required)', () => {
    expect(decideConsent({ ...base, closeRequestStatus: null })).toBe('awaiting_user');
  });
});

describe('Brief 0B §2 — anti-coercion preserved: dual consent whenever support is engaged', () => {
  it('coordinator claimed, user assented, support has NOT assented → awaiting_support', () => {
    expect(decideConsent({ ...base, coordinatorClaimedAt: 100 })).toBe('awaiting_support');
  });

  it('coordinator claimed + support assented + user assented → close_dual (unchanged)', () => {
    expect(decideConsent({ ...base, coordinatorClaimedAt: 100, supportAssentAt: 200 })).toBe('close_dual');
  });

  it('support engaged but user has not gestured → awaiting_user', () => {
    expect(decideConsent({ ...base, closeRequestStatus: null, coordinatorClaimedAt: 100 })).toBe('awaiting_user');
  });
});

describe('Brief 0B §3 — race: a claim landing mid-close flips solo → dual, never double-close', () => {
  it('the instant coordinatorClaimedAt is set, the derived outcome is awaiting_support, not a solo close', () => {
    const solo = decideConsent(base);
    const afterClaim = decideConsent({ ...base, coordinatorClaimedAt: 999 });
    expect(solo).toBe('close_solo');
    expect(afterClaim).toBe('awaiting_support');
  });

  it('an already-closed event never re-closes', () => {
    expect(decideConsent({ ...base, status: 'closed' })).toBe('already_closed');
  });
});

describe('Brief 0B §E4 — TAMPERING never clean-closes, even solo', () => {
  it('solo + tampering → tampering_blocked (needs a logged coordinator override)', () => {
    expect(decideConsent({ ...base, tamperingAt: 500 })).toBe('tampering_blocked');
  });
  it('dual + tampering → tampering_blocked', () => {
    expect(decideConsent({ ...base, coordinatorClaimedAt: 1, supportAssentAt: 2, tamperingAt: 500 })).toBe(
      'tampering_blocked',
    );
  });
});

describe('Brief 0B ACCEPTANCE [A] — the model is derived, with no solo special-case branch', () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(SRC, '../src/lib/closure-consent.ts'), 'utf8');

  it('has no `if (solo)` special case — solo falls out of the derived party set', () => {
    expect(src).not.toMatch(/if\s*\(\s*solo\s*\)/);
  });

  it('the solo close is atomically race-guarded: it re-checks no support engaged in the same write', () => {
    expect(src).toMatch(/coordinatorClaimedAt IS NULL AND supportAssentAt IS NULL/);
  });

  it('dual consent is not a hardcoded count of two — engagement is derived', () => {
    expect(src).toMatch(/isSupportEngaged/);
  });
});

/**
 * §E2 — the model is GESTURE-BLIND, and that is what makes it safe for the client to
 * render the model's answer directly.
 *
 * The client used to hardcode "awaiting confirmation" for both gestures, which hid the
 * duress signal but also hid a completed close — a survivor with no support contact was
 * told to wait for a party that did not exist. The client now renders what the model
 * returned. That is only safe because the decision never depends on WHICH gesture was
 * made, so both still land on the identical screen at any moment. This asserts that
 * property directly rather than trusting it.
 */
describe('§E2 the decision never depends on which gesture was made', () => {
  const states: Omit<ConsentState, 'closeRequestStatus'>[] = [
    { status: 'active', supportAssentAt: null, coordinatorClaimedAt: null, tamperingAt: null },
    { status: 'active', supportAssentAt: null, coordinatorClaimedAt: 1, tamperingAt: null },
    { status: 'active', supportAssentAt: 2, coordinatorClaimedAt: 1, tamperingAt: null },
    { status: 'active', supportAssentAt: null, coordinatorClaimedAt: null, tamperingAt: 5 },
    { status: 'closed', supportAssentAt: null, coordinatorClaimedAt: null, tamperingAt: null },
  ];

  it('sat and unsat produce the identical decision in every state', () => {
    for (const s of states) {
      expect(decideConsent({ ...s, closeRequestStatus: 'sat' })).toBe(
        decideConsent({ ...s, closeRequestStatus: 'unsat' }),
      );
    }
  });

  it('the derivation never reads the gesture value at all', () => {
    // It may only test for PRESENCE of a gesture (null vs not), never sat-vs-unsat.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../src/lib/closure-consent.ts'), 'utf8');
    const fn = source.slice(source.indexOf('export function decideConsent'), source.indexOf('recordUserAssent'));
    expect(fn).not.toMatch(/=== 'sat'|=== 'unsat'/);
  });
});
