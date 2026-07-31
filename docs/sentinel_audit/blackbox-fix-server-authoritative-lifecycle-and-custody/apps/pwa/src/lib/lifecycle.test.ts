import { describe, expect, it } from 'vitest';

import { hasReachableRecipient, isLinkReissueDue } from '@blackbox/shared';

/**
 * The orphaned-event hole had two root causes; these pin the pure rules that
 * close them (shared by the Worker enforcement and the PWA UI gate):
 *  - you must never ARM into a state that would notify no one;
 *  - an expired coordinator link on an UNRESOLVED event must regenerate.
 */
describe('hasReachableRecipient (armability gate)', () => {
  const TTL = 60 * 60 * 1000;

  it('rejects arming with no recipients at all', () => {
    expect(hasReachableRecipient([], true)).toBe(false);
  });

  it('rejects arming when the only recipient is on a non-deliverable channel', () => {
    // e.g. a guardian typed as a LINE display name that is not a real follower.
    expect(hasReachableRecipient([{ role: 'guardian', deliverable: false }], true)).toBe(false);
    expect(hasReachableRecipient([{ role: 'contact', deliverable: false }], true)).toBe(false);
  });

  it('allows arming with one deliverable contact', () => {
    expect(hasReachableRecipient([{ role: 'contact', deliverable: true }], true)).toBe(true);
  });

  it('allows arming with a deliverable guardian only when the guardian is enabled', () => {
    expect(hasReachableRecipient([{ role: 'guardian', deliverable: true }], true)).toBe(true);
    expect(hasReachableRecipient([{ role: 'guardian', deliverable: true }], false)).toBe(false);
  });

  it('never lets the emergency fallback alone satisfy armability', () => {
    expect(hasReachableRecipient([{ role: 'emergency', deliverable: true }], true)).toBe(false);
  });

  // The exact deadlock that was hit: guardian on an undeliverable channel, no contact.
  it('rejects the orphaned-event setup (guardian on a dead channel, nothing else)', () => {
    expect(
      hasReachableRecipient([{ role: 'guardian', deliverable: false }], true),
    ).toBe(false);
  });

  it('isLinkReissueDue: due once a full TTL elapses on an unresolved, notified event', () => {
    const base = {
      status: 'active',
      coordinatorClaimedAt: null,
      notifiedAt: 1_000,
      lastLinkIssuedAt: 1_000,
      ttlMs: TTL,
    };
    expect(isLinkReissueDue({ ...base, now: 1_000 + TTL - 1 })).toBe(false);
    expect(isLinkReissueDue({ ...base, now: 1_000 + TTL })).toBe(true);
  });

  it('isLinkReissueDue: never reissues a resolved/closed/claimed/un-notified event', () => {
    const now = 10_000_000;
    expect(
      isLinkReissueDue({ now, status: 'closed', coordinatorClaimedAt: null, notifiedAt: 1, lastLinkIssuedAt: 1, ttlMs: TTL }),
    ).toBe(false);
    expect(
      isLinkReissueDue({ now, status: 'active', coordinatorClaimedAt: 5, notifiedAt: 1, lastLinkIssuedAt: 1, ttlMs: TTL }),
    ).toBe(false);
    expect(
      isLinkReissueDue({ now, status: 'active', coordinatorClaimedAt: null, notifiedAt: null, lastLinkIssuedAt: 1, ttlMs: TTL }),
    ).toBe(false);
    expect(
      isLinkReissueDue({ now, status: 'active', coordinatorClaimedAt: null, notifiedAt: 1, lastLinkIssuedAt: null, ttlMs: TTL }),
    ).toBe(false);
  });
});
