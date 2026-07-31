import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchEventStatus } from '@/lib/activation/session-monitor';
import { isAlertActive } from '@/lib/active-alert';

/**
 * THE PHANTOM ALERT: "ALERT ACTIVE — RECORDING" for an event the server does not have.
 *
 * It survived hard resets because the local session lives in IndexedDB and the monitor
 * could never contradict it. `fetchStatus` returned `null` for EVERY non-200 — a 404 for
 * an event that genuinely does not exist was indistinguishable from "we're offline" — and
 * the monitor's `if (!status) return;` treated both as "change nothing". So a local
 * session pointing at a missing event stayed `active` forever, and every reload
 * re-hydrated it.
 *
 * The rule these pin: act on a POSITIVE answer, never on the absence of one.
 *   404/410  → the server says the event is not there  → tear the local session down
 *   offline / 5xx / unparseable → we could not ask     → change NOTHING, keep recording
 *
 * The second half matters as much as the first: a device recording a real emergency with
 * no signal must never have its alert ended because a request failed.
 */

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const respond = (status: number, body: unknown = {}): void => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
};

describe('a server that does not have the event ends the local alert', () => {
  it('404 (unknown event) reports as closed', async () => {
    respond(404, { error: 'unknown event' });
    await expect(fetchEventStatus('evt-gone', 'secret')).resolves.toBe('closed');
  });

  it('410 (retired route) reports as closed', async () => {
    respond(410, { error: 'gone' });
    await expect(fetchEventStatus('evt-gone', 'secret')).resolves.toBe('closed');
  });
});

describe('a server we could not REACH changes nothing', () => {
  it('a network failure yields null — never "closed"', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await expect(fetchEventStatus('evt-1', 'secret')).resolves.toBeNull();
  });

  it('a 500 yields null — a broken server is not a verdict about the alert', async () => {
    respond(500, { error: 'internal' });
    await expect(fetchEventStatus('evt-1', 'secret')).resolves.toBeNull();
  });

  it('an unparseable 200 yields null rather than a false status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEventStatus('evt-1', 'secret')).resolves.toBeNull();
  });
});

describe('a live event is still reported honestly', () => {
  it('200 active → active; 200 closed → closed', async () => {
    respond(200, { status: 'active' });
    await expect(fetchEventStatus('evt-1', 'secret')).resolves.toBe('active');
    respond(200, { status: 'closed' });
    await expect(fetchEventStatus('evt-1', 'secret')).resolves.toBe('closed');
  });
});

describe('the local predicate that drove the phantom screen', () => {
  it('only an `active` session is an active alert', () => {
    expect(isAlertActive({ status: 'active' })).toBe(true);
    // Every terminal/《interrupted》state must read as NOT an alert, so a torn-down or
    // never-persisted session can never keep the alert screen up.
    for (const status of ['closed', 'interrupted'] as const) {
      expect(isAlertActive({ status })).toBe(false);
    }
    expect(isAlertActive(null)).toBe(false);
    expect(isAlertActive(undefined)).toBe(false);
  });
});
