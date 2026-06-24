/**
 * Brief 16 §3 tripwire — corrected escalation. A pending CLEAN close re-prompts
 * the coordinator at 60s and declares the coordinator path FAILED at 180s
 * (escalating to the guardian tier). Duress/tampering/non-active/guardian-tier
 * events never time out toward closure.
 */
import { describe, expect, it } from 'vitest';

import { CLOSURE_FAIL_MS, CLOSURE_REPROMPT_MS, escalationAction } from '../src/lib/closure-timeout';

const base = {
  status: 'active',
  escalationTier: 'coordinator' as string | null,
  closeRequestStatus: 'sat' as string | null,
  closeRequestedAt: 0,
  tamperingAt: null as number | null,
  closureRepromptAt: null as number | null,
  coordinatorPathFailedAt: null as number | null,
  now: 0,
};

describe('§3 escalation policy: 60s coordinator reprompt, 180s coordinator-path-fail', () => {
  it('locks the timings', () => {
    expect(CLOSURE_REPROMPT_MS).toBe(60_000);
    expect(CLOSURE_FAIL_MS).toBe(180_000);
  });

  it('does nothing before 60s', () => {
    expect(escalationAction({ ...base, now: 59_000 })).toBe('none');
  });

  it('reprompts the coordinator once between 60s and 180s', () => {
    expect(escalationAction({ ...base, now: 61_000 })).toBe('reprompt');
    expect(escalationAction({ ...base, now: 90_000, closureRepromptAt: 61_000 })).toBe('none');
  });

  it('fails the coordinator path past 180s', () => {
    expect(escalationAction({ ...base, now: 181_000, closureRepromptAt: 61_000 })).toBe('fail');
    // once failed, no repeat
    expect(escalationAction({ ...base, now: 200_000, coordinatorPathFailedAt: 181_000 })).toBe('none');
  });

  it('never escalates a duress, tampering, guardian-tier, or non-active event', () => {
    expect(escalationAction({ ...base, now: 999_000, closeRequestStatus: 'unsat' })).toBe('none');
    expect(escalationAction({ ...base, now: 999_000, tamperingAt: 5 })).toBe('none');
    expect(escalationAction({ ...base, now: 999_000, escalationTier: 'guardian' })).toBe('none');
    expect(escalationAction({ ...base, now: 999_000, status: 'closed' })).toBe('none');
  });
});
