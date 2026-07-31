import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/log', () => ({ log: { error: vi.fn() } }));

import { checkReadiness, loadGrants, saveGrants } from './readiness';

/**
 * Brief 15 §C tripwire — readiness re-verifies (never re-prompts) and is honest
 * about what it cannot verify. mic + location are required; camera is optional.
 */

function stubLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

/** Stub navigator.permissions.query to return a fixed state per name, or make
 *  the API absent (iOS) when `states` is null. */
function stubNavigator(states: Record<string, string> | null, ua = 'test'): void {
  vi.stubGlobal('navigator', {
    userAgent: ua,
    permissions: states
      ? { query: async ({ name }: { name: string }) => ({ state: states[name] ?? 'prompt' }) }
      : undefined,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('saveGrants / loadGrants', () => {
  it('round-trips the grant snapshot with a timestamp', () => {
    stubLocalStorage();
    saveGrants({ mic: true, camera: false, location: true });
    const g = loadGrants();
    expect(g).toMatchObject({ mic: true, camera: false, location: true });
  });

  it('returns null when nothing is stored', () => {
    stubLocalStorage();
    expect(loadGrants()).toBeNull();
  });
});

describe('checkReadiness — live Permissions API', () => {
  it('is ready when mic + location are granted (camera irrelevant)', async () => {
    stubLocalStorage();
    stubNavigator({ microphone: 'granted', geolocation: 'granted', camera: 'denied' });
    const r = await checkReadiness();
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('is NOT ready and names the missing grant when mic is revoked', async () => {
    stubLocalStorage();
    stubNavigator({ microphone: 'denied', geolocation: 'granted', camera: 'granted' });
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.missing).toContain('Microphone');
    expect(r.missing).not.toContain('Location');
  });
});

describe('checkReadiness — iOS fallback (no Permissions API)', () => {
  it('trusts the persisted onboarding grant when it cannot query', async () => {
    stubLocalStorage();
    saveGrants({ mic: true, camera: true, location: true });
    stubNavigator(null, 'iPhone'); // permissions API absent
    const r = await checkReadiness();
    expect(r.mic).toBe('granted');
    expect(r.location).toBe('granted');
    expect(r.ready).toBe(true);
  });

  it('reports NOT ready when there is no stored grant and no API', async () => {
    stubLocalStorage();
    stubNavigator(null, 'iPhone');
    const r = await checkReadiness();
    expect(r.ready).toBe(false);
    expect(r.mic).toBe('unknown');
  });
});
