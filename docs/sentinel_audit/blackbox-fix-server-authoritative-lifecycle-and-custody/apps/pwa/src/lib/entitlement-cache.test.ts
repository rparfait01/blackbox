import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheEntitlement, getCachedEntitlement, mayArmByCache } from './auth';

/**
 * Brief 28 §2 — the offline entitlement cache is the §0 arm gate's local half. Its
 * behavior is safety-critical: a cleared cache must FAIL OPEN (an offline reinstall is
 * never a lockout), and once activated it must never re-lock. Behavioral, not grep.
 */

function installLocalStorage(): void {
  const store = new Map<string, string>();
  // Minimal, synchronous localStorage stub for the node test env.
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe('§2 an empty cache is UNKNOWN and FAILS OPEN', () => {
  it('nothing cached → status unknown, and the arm gate is permissive', () => {
    expect(getCachedEntitlement().status).toBe('unknown');
    // The §0 line: a fresh install / cleared cache / offline reinstall can still ARM.
    expect(mayArmByCache()).toBe(true);
  });
});

describe('§2 a server-confirmed unactivated GATES (the paywall bites known no)', () => {
  it('cached unactivated → status unactivated, arm gate false', () => {
    cacheEntitlement({ status: 'unactivated', source: null });
    expect(getCachedEntitlement().status).toBe('unactivated');
    expect(mayArmByCache()).toBe(false);
  });
});

describe('§2 activated arms and NEVER re-locks (monotonic mirror of the server)', () => {
  it('cached activated → arm gate true', () => {
    cacheEntitlement({ status: 'activated', source: 'org_code' });
    expect(getCachedEntitlement().status).toBe('activated');
    expect(getCachedEntitlement().source).toBe('org_code');
    expect(mayArmByCache()).toBe(true);
  });

  it('a later unactivated (or unknown) NEVER overwrites activated', () => {
    cacheEntitlement({ status: 'activated', source: 'purchase_web' });
    cacheEntitlement({ status: 'unactivated', source: null });
    expect(getCachedEntitlement().status).toBe('activated');
    expect(mayArmByCache()).toBe(true);
  });
});
