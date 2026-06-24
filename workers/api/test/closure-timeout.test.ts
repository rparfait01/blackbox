/**
 * Brief 15 §E5 tripwire — awaiting-confirmation timeout. A pending CLEAN close
 * re-prompts at 60s and advances tier at 180s; duress/tampering/non-active never
 * time out toward closure.
 */
import { describe, expect, it } from 'vitest';

import {
  CLOSURE_ADVANCE_MS,
  CLOSURE_REPROMPT_MS,
  closureTimeoutAction,
} from '../src/lib/closure-timeout';

const base = {
  status: 'active',
  closeRequestStatus: 'sat' as string | null,
  closeRequestedAt: 0,
  tamperingAt: null as number | null,
  closureRepromptAt: null as number | null,
  closureAdvancedAt: null as number | null,
  now: 0,
};

describe('§E5 policy: 60s re-prompt, 180s advance', () => {
  it('locks the Royce P1 timings', () => {
    expect(CLOSURE_REPROMPT_MS).toBe(60_000);
    expect(CLOSURE_ADVANCE_MS).toBe(180_000);
  });

  it('does nothing before 60s', () => {
    expect(closureTimeoutAction({ ...base, now: 59_000 })).toBe('none');
  });

  it('re-prompts once between 60s and 180s', () => {
    expect(closureTimeoutAction({ ...base, now: 61_000 })).toBe('reprompt');
    // already re-prompted → quiet until the advance window
    expect(closureTimeoutAction({ ...base, now: 70_000, closureRepromptAt: 61_000 })).toBe('none');
  });

  it('advances tier once past 180s', () => {
    expect(closureTimeoutAction({ ...base, now: 181_000, closureRepromptAt: 61_000 })).toBe('advance');
    expect(
      closureTimeoutAction({ ...base, now: 200_000, closureRepromptAt: 61_000, closureAdvancedAt: 181_000 }),
    ).toBe('none');
  });

  it('never times out a duress, tampering, or non-active event', () => {
    expect(closureTimeoutAction({ ...base, now: 999_000, closeRequestStatus: 'unsat' })).toBe('none');
    expect(closureTimeoutAction({ ...base, now: 999_000, tamperingAt: 5 })).toBe('none');
    expect(closureTimeoutAction({ ...base, now: 999_000, status: 'closed' })).toBe('none');
  });
});
