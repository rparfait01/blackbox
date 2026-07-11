import { describe, expect, it } from 'vitest';

import { shouldAutoCloseOrphan, MAX_ACTIVE_MS } from '../src/lib/closure-timeout';

/**
 * Brief 20 §2 tripwire — the orphan auto-close decision. An open event must never
 * outlive the owner's ability to see and close it: a deleted owner is always
 * closed; anything past the absolute ceiling is closed; but a LIVE duress/tampering
 * event is never age-closed (responders stay engaged), and a normal, recent,
 * owned event is left alone.
 */
const now = 10 * MAX_ACTIVE_MS;
const base = { status: 'active', createdAt: now, ownerMissing: false, closeRequestDuress: 0, tamperingAt: null, now };

describe('shouldAutoCloseOrphan', () => {
  it('leaves a normal, recent, owned event alone', () => {
    expect(shouldAutoCloseOrphan(base)).toBe(false);
  });

  it('closes an event whose owning account is gone, regardless of age or disposition', () => {
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true })).toBe(true);
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true, closeRequestDuress: 1 })).toBe(true);
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true, tamperingAt: now })).toBe(true);
  });

  it('closes an owned event open past the absolute ceiling', () => {
    expect(shouldAutoCloseOrphan({ ...base, createdAt: now - MAX_ACTIVE_MS - 1 })).toBe(true);
  });

  it('never age-closes a live duress or tampering event (responders engaged)', () => {
    const old = now - MAX_ACTIVE_MS - 1;
    expect(shouldAutoCloseOrphan({ ...base, createdAt: old, closeRequestDuress: 1 })).toBe(false);
    expect(shouldAutoCloseOrphan({ ...base, createdAt: old, tamperingAt: now })).toBe(false);
  });

  it('never acts on an already-closed event', () => {
    expect(shouldAutoCloseOrphan({ ...base, status: 'closed', ownerMissing: true })).toBe(false);
  });
});
