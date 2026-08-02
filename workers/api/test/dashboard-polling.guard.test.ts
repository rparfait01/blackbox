import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../src/dashboard/page.ts', import.meta.url), 'utf8');

/**
 * Comments stripped, for the NEGATIVE assertions only.
 *
 * This file documents the removed code by quoting it, and the page's own comments do the
 * same. A guard that greps raw source therefore matches its own prose and fails on how
 * something is documented rather than on what it does — I have now hit that three times
 * across Briefs 37, 39 and 49, so it gets a named helper rather than another inline fix.
 */
const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Brief 49 — the coordinator dashboard's polling, bounded.
 *
 * WHAT HAPPENED. `setInterval(poll,3000)` with no clearInterval anywhere, no visibility
 * handling, and no stop on closure; alongside `ws.onclose = setTimeout(connectWS,3000)` with
 * no backoff and no ceiling. A tab left open on an event that closed days ago asked the
 * Worker for its state every three seconds — 28,800 requests a day, per tab, about nothing —
 * and the notified view added 17,280 more.
 *
 * That exhausted the account's daily request budget, and when the budget went the ALERT PATH
 * went with it. The 521s and 522s were not a platform incident; they were this. Worse, the
 * fixed 3s socket retry meant a failing Worker generated the load that kept it failing: the
 * outage fed itself.
 *
 * The lesson these tests exist to hold: a poll with no exit condition is a load generator,
 * not a correctness guarantee. Every loop below must be able to decide to stop.
 */
describe('§A polling stops when the event closes', () => {
  it('the coordinator poll has a terminal state and says so', () => {
    expect(page).toMatch(/function stopPolling\(st\)/);
    expect(page).toMatch(/if\(st\.terminal===true\|\|st\.active===false\)\{ stopPolling\(st\); return; \}/);
    expect(page).toMatch(/Reload for current state\./);
  });

  it('the closure notice names the DTG, reusing the ONE formatter', () => {
    // Preformatted server-side (contact-state.ts → formatDtg). A second DTG formatter
    // written in inline browser JS would be free to drift — Brief 29 §-1, reuse never
    // re-implement.
    const contactState = readFileSync(new URL('../src/lib/contact-state.ts', import.meta.url), 'utf8');
    expect(contactState).toMatch(/closedDtg: event\.closedAt \? formatDtg\(event\.closedAt\) : null/);
    expect(page).toMatch(/st\.closedDtg/);
  });

  it('no unbounded setInterval poll survives anywhere on the page', () => {
    // The elapsed-time ticker is local and makes no requests, so it is allowed to remain an
    // interval. Anything that FETCHES must be a re-armed timeout that can stop.
    expect(code).not.toMatch(/setInterval\(poll,\s*3000\)/);
    expect(code).not.toMatch(/setInterval\(poll,\s*5000\)/);
    expect(page).toMatch(/timer=setTimeout\(function\(\)\{ poll\(\); \}, intervalMs\(\)\)/);
    expect(page).toMatch(/pollTimer=setTimeout\(function\(\)\{ poll\(\); \}, pollIntervalMs\(\)\)/);
  });
});

describe('§B hidden tabs poll slowly, and resume instantly', () => {
  it('30s hidden, 3s visible on the coordinator view', () => {
    expect(page).toMatch(/var POLL_LIVE_MS=3000, POLL_HIDDEN_MS=30000;/);
    expect(page).toMatch(/return document\.hidden \? POLL_HIDDEN_MS : POLL_LIVE_MS;/);
  });

  it('visibilitychange polls immediately rather than waiting out the interval', () => {
    // A coordinator returning to the tab must not see state up to 30s stale.
    const handlers = page.match(/visibilitychange/g) ?? [];
    expect(handlers.length).toBe(2); // coordinator view + notified view
    expect(page).toMatch(/if\(!document\.hidden\)\{ poll\(\); \} else \{ schedulePoll\(\); \}/);
  });
});

describe('§C the socket reconnect is bounded — the P0', () => {
  it('exponential backoff 3/6/12/24/48 with a 60s cap', () => {
    expect(page).toMatch(/var WS_BACKOFF_MS=\[3000,6000,12000,24000,48000\], WS_CAP_MS=60000, WS_MAX_ATTEMPTS=8;/);
    expect(page).toMatch(/if\(delay>WS_CAP_MS\) delay=WS_CAP_MS;/);
  });

  it('the fixed 3s retry is gone', () => {
    // This exact line is what turned a failing Worker into a self-sustaining outage.
    expect(code).not.toMatch(/setTimeout\(connectWS,\s*3000\)/);
  });

  it('there is an attempt ceiling, and giving up is visible', () => {
    expect(page).toMatch(/if\(wsAttempts>=WS_MAX_ATTEMPTS\)\{ wsGiveUp\(\); return; \}/);
    expect(page).toMatch(/Connection lost — reload to reconnect\./);
    expect(page).toMatch(/id="wsNotice"/);
  });

  it('never reconnects on a closed event', () => {
    expect(page).toMatch(/if\(pollStopped\|\|wsGaveUp\) return;/);
    // Closing the page's poll also tears the socket down rather than leaving it dialling.
    expect(page).toMatch(/pollStopped=true;[\s\S]{0,200}closeSocket\(\);/);
  });

  it('a successful connection resets the ladder', () => {
    // Otherwise a long-lived tab that reconnects once an hour would eventually exhaust its
    // attempts and give up on a socket that works.
    expect(page).toMatch(/ws\.onopen=function\(\)\{ wsAttempts=0; \}/);
  });
});

describe('§D the notified view gets the same treatment, not a lesser one', () => {
  it('stops on closure and slows when hidden', () => {
    expect(page).toMatch(/var POLL_LIVE_MS=5000, POLL_HIDDEN_MS=30000;/);
    expect(page).toMatch(/function stop\(st\)/);
    expect(page).toMatch(/id="notifiedEnded"/);
  });

  it('the last coordinates are never left looking current', () => {
    // The view shows one pair of coordinates; a frozen page with no notice is how a stale
    // position gets read as a live one.
    expect(page).toMatch(/notifiedEnded[\s\S]{0,400}Reload for current state\./);
  });
});

describe('§C jitter — desynchronise the retry wave', () => {
  it('backoff is jittered ±25%', () => {
    // Without jitter every tab that lost the socket at the same instant — which is what a
    // quota breach or a deploy causes — retries in lockstep, so a recovering Worker is hit by
    // a synchronised wave instead of a spread.
    expect(page).toMatch(/delay=Math\.round\(delay\*\(0\.75\+Math\.random\(\)\*0\.5\)\)/);
  });
});

describe('§E1/§E2 server side, and what it honestly cannot do', () => {
  const ceiling = readFileSync(new URL('../src/lib/poll-ceiling.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('the ceiling does not claim to protect the quota', () => {
    // By the time the limiter runs, the request has already invoked the Worker and already
    // counted. Only the client loop stopping reduces requests. Saying otherwise would be the
    // overclaim Brief 38 §B had to correct.
    expect(ceiling).toMatch(/does NOT protect the Workers request cap/);
  });

  it('a live event gets generous headroom, and the first poll always passes', () => {
    expect(ceiling).toMatch(/LIVE_LIMIT_PER_MIN = 40/);
    expect(ceiling).toMatch(/buckets\.set\(key, \{ windowStart: now, count: 1 \}\);\s*\n\s*return \{ allowed: true/);
  });

  it('a closed event answers with an explicit terminal flag', () => {
    expect(index).toMatch(/terminal: true, reason: 'event_closed'/);
    expect(index).toMatch(/reason: 'poll_ceiling'/);
    // …and the client acts on the flag, not only on active:false.
    expect(page).toMatch(/if\(st\.terminal===true\|\|st\.active===false\)/);
  });

  it('the limit of the terminal payload is stated, not implied', () => {
    // A page whose JS predates this fix ignores response bodies entirely; only a reload picks
    // up the bounded loop.
    expect(index).toMatch(/cannot stop a page whose JavaScript predates the fix/);
  });
});

describe('§E3 the dashboard HTML is not cacheable', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('dashboard and notified HTML are served no-store', () => {
    // The polling loop is inlined into this page, so a stale copy keeps the old loop alive
    // and no server change can reach it.
    expect(index).toMatch(/const NO_STORE_HTML = \{ 'Cache-Control': 'no-store' \} as const;/);
    expect((index.match(/NO_STORE_HTML,?\s*\)?/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('records that a service worker is not involved', () => {
    // The PWA's SW is registered on the Pages origin; service workers are origin-scoped and
    // cannot intercept the Worker origin. No cache key to bump.
    expect(index).toMatch(/service worker is NOT involved/);
  });
});

describe('§F request headroom is measured, never estimated', () => {
  const headroom = readFileSync(new URL('../src/lib/request-headroom.ts', import.meta.url), 'utf8');

  it('reports NOT MEASURED rather than inventing a number', () => {
    expect(headroom).toMatch(/REQUESTS: NOT MEASURED/);
    expect(headroom).toMatch(/never estimates/);
  });

  it('alerts at 80%, at error level', () => {
    expect(headroom).toMatch(/HEADROOM_ALERT_AT = 0\.8/);
    expect(headroom).toMatch(/alert: 'request_headroom_low'/);
    expect(headroom).toMatch(/level: 'error'/);
  });

  it('names the consequence rather than treating it as a capacity metric', () => {
    expect(headroom).toMatch(/a trigger creates a local capture and notifies nobody/);
  });
});
