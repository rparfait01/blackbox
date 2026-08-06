import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearTriggerBattery, getTriggerBattery, readBattery, rememberTriggerBattery } from './battery';

/**
 * Brief 59 — the instrument that replaced a guess.
 *
 * The property that matters is that an ABSENT reading stays absent. A battery figure that
 * silently defaults to 0 is the same defect class as a capture claim nobody observed, and it
 * would be worse than the estimate it replaced.
 */
const realNav = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true });
  clearTriggerBattery();
  vi.useRealTimers();
});

function withNav(getBattery: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...realNav, getBattery },
    configurable: true,
  });
}

describe('an absent reading is null, never zero', () => {
  it('a platform with no battery API reports null', async () => {
    // Firefox and every iOS browser. This is the COMMON case, not an error case.
    withNav(undefined);
    expect(await readBattery()).toBeNull();
  });

  it('a rejecting API reports null rather than throwing onto the alert path', async () => {
    withNav(() => Promise.reject(new Error('nope')));
    expect(await readBattery()).toBeNull();
  });

  it('a malformed level reports null rather than a clamped guess', async () => {
    withNav(() => Promise.resolve({ level: Number.NaN, charging: false }));
    expect(await readBattery()).toBeNull();
  });

  it('a promise that never settles cannot delay a trigger', async () => {
    // The ceiling exists because this runs on the activation path. Nothing may stand between her
    // and the alert — least of all an instrument measuring the alert.
    withNav(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await readBattery(50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a real reading is carried faithfully', () => {
  it('reads level and charging, and nothing else', async () => {
    // dischargingTime/chargingTime are the high-entropy fingerprinting fields and are never read.
    withNav(() => Promise.resolve({ level: 0.11, charging: false, dischargingTime: 1234 }));
    const r = await readBattery();
    expect(r).toEqual({ level: 0.11, charging: false });
    expect(r && 'dischargingTime' in r).toBe(false);
  });

  it('clamps a level outside 0-1 rather than reporting it', async () => {
    withNav(() => Promise.resolve({ level: 1.4, charging: true }));
    expect((await readBattery())?.level).toBe(1);
  });
});

describe('the trigger reading does not leak between events', () => {
  it('is cleared when a session ends', () => {
    rememberTriggerBattery({ level: 0.5, charging: false });
    expect(getTriggerBattery()?.level).toBe(0.5);
    clearTriggerBattery();
    expect(getTriggerBattery(), 'a later event would inherit an earlier one').toBeNull();
  });
});
