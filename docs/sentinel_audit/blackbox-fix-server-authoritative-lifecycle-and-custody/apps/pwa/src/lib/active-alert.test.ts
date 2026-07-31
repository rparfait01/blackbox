import { describe, expect, it } from 'vitest';

import { isAlertActive } from './active-alert';

/**
 * Regression guard (Fix Brief 8 P0): the Settings entry point is locked while an
 * alert is active. This predicate drives that lock on every surface (the gear on
 * both home screens + the Settings route guard). It has regressed before — this
 * pins it so an active session always reads as "locked".
 */
describe('isAlertActive (settings lockdown predicate)', () => {
  it('is true for an active session → Settings must be locked', () => {
    expect(isAlertActive({ status: 'active' })).toBe(true);
  });

  it('is false for a closed session', () => {
    expect(isAlertActive({ status: 'closed' })).toBe(false);
  });

  it('is false for an interrupted session', () => {
    expect(isAlertActive({ status: 'interrupted' })).toBe(false);
  });

  it('is false when there is no session', () => {
    expect(isAlertActive(null)).toBe(false);
    expect(isAlertActive(undefined)).toBe(false);
  });
});
