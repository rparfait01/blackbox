/**
 * Brief 15 §E3/§E4 tripwire — repetition→tampering threshold + disposition.
 */
import { describe, expect, it } from 'vitest';

import {
  TAMPERING_THRESHOLD,
  TAMPERING_WINDOW_MS,
  crossesTamperingThreshold,
  disposition,
} from '../src/lib/tampering';

describe('tampering config', () => {
  it('defaults to ≥2 duress within 120s (Royce-tunable)', () => {
    expect(TAMPERING_THRESHOLD).toBe(2);
    expect(TAMPERING_WINDOW_MS).toBe(120_000);
  });
});

describe('crossesTamperingThreshold', () => {
  it('escalates only at or above the threshold', () => {
    expect(crossesTamperingThreshold(1)).toBe(false);
    expect(crossesTamperingThreshold(2)).toBe(true);
    expect(crossesTamperingThreshold(5)).toBe(true);
  });
});

describe('disposition — tampering outranks duress outranks clean', () => {
  it('TAMPERING when escalated, regardless of the latest status', () => {
    expect(disposition('sat', 123)).toBe('TAMPERING');
    expect(disposition('unsat', 123)).toBe('TAMPERING');
  });
  it('DURESS for an un-escalated unsat', () => {
    expect(disposition('unsat', null)).toBe('DURESS');
  });
  it('SAT only for a clean, un-escalated close', () => {
    expect(disposition('sat', null)).toBe('SAT');
    expect(disposition(null, null)).toBe('SAT');
  });
});
