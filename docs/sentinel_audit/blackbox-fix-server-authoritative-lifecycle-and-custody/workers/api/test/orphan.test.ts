import { describe, expect, it } from 'vitest';

import { shouldAutoCloseOrphan, MAX_ACTIVE_MS, DARK_UNCLAIMED_MS } from '../src/lib/closure-timeout';

/**
 * Brief 20 §2 + Brief 23 §1 tripwire — the orphan auto-close decision. An open
 * event must never outlive the owner's ability to see and close it: a deleted owner
 * is always closed; a DARK + UNCLAIMED event is closed on the short bound; anything
 * past the absolute ceiling is closed. But a LIVE duress/tampering event, a
 * coordinator-CLAIMED event, and a live-FEED (recent heartbeat) event are never
 * touched; and a normal, recent, owned event is left alone.
 */
const now = 10 * MAX_ACTIVE_MS;
const base = {
  status: 'active',
  createdAt: now,
  ownerMissing: false,
  closeRequestDuress: 0,
  tamperingAt: null,
  lastHeartbeatAt: now, // fresh heartbeat = live feed
  coordinatorClaimedAt: null,
  now,
};

describe('shouldAutoCloseOrphan', () => {
  it('leaves a normal, recent, owned, live-feed event alone', () => {
    expect(shouldAutoCloseOrphan(base)).toBe(false);
  });

  it('closes an event whose owning account is gone, regardless of age or disposition', () => {
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true })).toBe(true);
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true, closeRequestDuress: 1 })).toBe(true);
    expect(shouldAutoCloseOrphan({ ...base, ownerMissing: true, tamperingAt: now })).toBe(true);
  });

  it('§1: closes a DARK + UNCLAIMED event on the short bound', () => {
    const darkBeat = now - DARK_UNCLAIMED_MS - 1;
    expect(shouldAutoCloseOrphan({ ...base, lastHeartbeatAt: darkBeat, coordinatorClaimedAt: null })).toBe(true);
  });

  it('§1: does NOT close a dark event once a coordinator has CLAIMED it', () => {
    const darkBeat = now - DARK_UNCLAIMED_MS - 1;
    expect(shouldAutoCloseOrphan({ ...base, lastHeartbeatAt: darkBeat, coordinatorClaimedAt: now })).toBe(false);
  });

  it('§1: does NOT close an unclaimed event whose feed is still live (recent heartbeat)', () => {
    const recentBeat = now - 30_000; // 30s ago, well within the bound
    expect(shouldAutoCloseOrphan({ ...base, lastHeartbeatAt: recentBeat, coordinatorClaimedAt: null })).toBe(false);
  });

  it('§1: never closes a dark+unclaimed DURESS/TAMPERING event (responders engaged)', () => {
    const darkBeat = now - DARK_UNCLAIMED_MS - 1;
    expect(shouldAutoCloseOrphan({ ...base, lastHeartbeatAt: darkBeat, closeRequestDuress: 1 })).toBe(false);
    expect(shouldAutoCloseOrphan({ ...base, lastHeartbeatAt: darkBeat, tamperingAt: now })).toBe(false);
  });

  it('closes an owned event open past the absolute ceiling', () => {
    expect(shouldAutoCloseOrphan({ ...base, createdAt: now - MAX_ACTIVE_MS - 1 })).toBe(true);
  });

  it('never acts on an already-closed event', () => {
    expect(shouldAutoCloseOrphan({ ...base, status: 'closed', ownerMissing: true })).toBe(false);
  });
});
