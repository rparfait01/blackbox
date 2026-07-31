import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../src/channels/router';
import {
  CANARY_CONTACT_EMAIL,
  CANARY_CONTACT_PHONE,
  CANARY_EMAIL,
  suppressionFor,
} from '../src/lib/canary';
import { isReservedEmail, isReservedPhone } from '../src/channels/reserved';
import type { Env } from '../src/types';

/**
 * Brief 35 §D — THE SUPPRESSION PATH IS THE HAZARD THIS BRIEF CREATED, so it gets the
 * tripwire.
 *
 * §C needed a canary that completes a real round trip without messaging a real person,
 * which means a code path whose entire purpose is to NOT DELIVER. Brief 31 refused
 * exactly that shape for the acceptance suite and gave the reason: a test-mode flag, if
 * it were ever set wrongly or reachable by a client, would silently swallow a REAL
 * alert — the worst failure this system has.
 *
 * So the rule is not "trust the flag". It is: suppress only when the event is flagged
 * AND its owner is still a canary account, both re-derived server-side at dispatch time.
 * Everything else — a flag on a real account, a missing event, a deleted owner, a
 * tokenless trigger — DISPATCHES. These tests exist to make that asymmetry impossible to
 * quietly reverse, because the direction of the failure is the entire safety argument.
 */

type Ep = { channel: string; channelIdentifier: string; priority: number };
type EventRow = { isTest: number; userId: string | null } | null;

/**
 * Fake D1 that answers the two lookups the suppression predicate makes, and nothing
 * else. `event: null` models an event row that is gone; `canary: false` models the flag
 * appearing on an account that is not a canary.
 */
function fakeEnv(endpoints: Ep[], opts: { event?: EventRow; canary?: boolean } = {}) {
  const deliveries: Array<{ status: string; detail: string | null }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            all: async () =>
              sql.includes('FROM contact_endpoints')
                ? { results: endpoints.map((e, i) => ({ id: `ep${i}`, contactId: 'c1', verifiedAt: null, createdAt: 0, ...e })) }
                : { results: [] },
            first: async () => {
              if (sql.includes('SELECT isTest, userId FROM events')) {
                return opts.event === undefined ? { isTest: 0, userId: 'u1' } : opts.event;
              }
              if (sql.includes('SELECT isCanary FROM users')) {
                return { isCanary: opts.canary ? 1 : 0 };
              }
              return null;
            },
            run: async () => {
              if (sql.startsWith('INSERT INTO delivery_records')) {
                // Column order in lib/delivery.ts: id, eventId, messageKind, channel,
                // status, providerMessageId, detail, …
                deliveries.push({ status: String(args[4]), detail: (args[6] ?? null) as string | null });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    SENDGRID_API_KEY: 'sg-key',
    SENDGRID_FROM_EMAIL: 'from@example.com',
  } as unknown as Env;
  return { env, deliveries };
}

/**
 * A RECORDING fetch stub. It must be a `vi.fn` and not a bare async function: the central
 * claim of these tests is "no provider was called", and that can only be asserted against
 * a call list. A plain stub has no `.mock`, so `providerCalls()` would return [] and every
 * "nothing was contacted" assertion would pass vacuously — proving nothing at exactly the
 * point where proof matters most.
 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('line.me')
        ? new Response('{}', { status: 200, headers: { 'x-line-request-id': 'lid-1' } })
        : new Response('', { status: 202, headers: { 'x-message-id': 'mid-1' } }),
    ),
  );
}

const providerCalls = () =>
  ((fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? []).map((c) => String(c[0]));

const message = {
  kind: 'activation' as const,
  eventId: 'e1',
  payload: {
    userDisplayName: 'Survivor',
    dashboardUrl: 'https://x/d',
    summaryUrl: 'https://x/s',
    audioUrl: 'https://x/a',
    location: null,
    threatSummary: null,
    emergency: null,
  },
};

// A REAL contact — a live LINE id and a real inbox. If suppression ever leaked, these
// are the destinations that would be hit, so they are deliberately not reserved
// addresses: Brief 31's address rule must not be what saves these tests.
const realEndpoints: Ep[] = [
  { channel: 'line', channelIdentifier: 'U8f53386494d2880f3c59008f2f1f64ee', priority: 1 },
  { channel: 'email', channelIdentifier: 'someone@theirdomain.example', priority: 2 },
];

afterEach(() => vi.unstubAllGlobals());

describe('§C the canary can only ever address provably undeliverable destinations', () => {
  /**
   * The layer UNDER the flag. Suppression is the primary guarantee; this is what holds if
   * suppression itself is ever broken, and it is a property of the addresses rather than
   * of any code path — Brief 31's rule, still load-bearing.
   *
   * It is a test and not a comment because a plausible-looking constant is exactly how
   * this fails: `+1 555 010 0199` reads as a fictional number and is not one (555 is the
   * area code there, not the exchange). That value shipped, and the runtime assertion in
   * provisionCanary caught it — on a PRODUCTION deploy. This catches it in CI instead.
   */
  it('every canary address is RFC 2606 / NANP reserved', () => {
    expect(isReservedEmail(CANARY_EMAIL)).toBe(true);
    expect(isReservedEmail(CANARY_CONTACT_EMAIL)).toBe(true);
    expect(isReservedPhone(CANARY_CONTACT_PHONE)).toBe(true);
  });
});

describe('§C the canary is suppressed — and says so honestly', () => {
  it('a canary-owned test event reaches NO provider and records suppressed_test', async () => {
    stubFetch();
    const { env, deliveries } = fakeEnv(realEndpoints, { event: { isTest: 1, userId: 'canary' }, canary: true });
    const r = await dispatch(env, 'c1', message);

    // Not one provider call. The gate exists to prove the transport works without
    // spending a message on a person.
    expect(providerCalls()).toEqual([]);
    // Every endpoint is accounted for — a suppression that dropped an endpoint from the
    // record would make the delivery log lie by omission.
    expect(deliveries.map((d) => d.status)).toEqual(['suppressed_test', 'suppressed_test']);
    expect(deliveries.every((d) => d.detail === 'canary_event_not_dispatched')).toBe(true);
    // NOT delivered. A canary run that reported delivery would prove the opposite of
    // what it exists to prove, and the deploy gate asserts on exactly this.
    expect(r.delivered).toBe(false);
    expect(r.channel).toBeNull();
    expect(r.attempts.every((a) => a.reason === 'canary_event_not_dispatched')).toBe(true);
  });
});

describe('§D suppression can never reach a real event — the asymmetry', () => {
  it('the flag on a NON-canary account DISPATCHES NORMALLY (and is alerted, not obeyed)', async () => {
    stubFetch();
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    // The exact catastrophe: events.isTest = 1 on a real survivor's account, however it
    // got there — bad migration, stray UPDATE, bug.
    const { env, deliveries } = fakeEnv(realEndpoints, { event: { isTest: 1, userId: 'real-survivor' }, canary: false });
    const r = await dispatch(env, 'c1', message);

    // Her alert went out. That is the whole safety argument: the failure costs a test
    // run, never a life.
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('line');
    expect(deliveries.some((d) => d.status === 'suppressed_test')).toBe(false);
    expect(providerCalls().some((u) => u.includes('line.me'))).toBe(true);
    // …and it is an ALERTABLE operator condition, because nothing user-facing can set
    // that column, so its presence means something wrote to the database directly.
    const alert = errors.find((l) => l.includes('canary_flag_on_non_canary_account'));
    expect(alert).toBeTruthy();
    expect(alert).toContain('"level":"error"');
  });

  it('a canary ACCOUNT with an unflagged event still dispatches — both conditions required', async () => {
    stubFetch();
    const { env } = fakeEnv(realEndpoints, { event: { isTest: 0, userId: 'canary' }, canary: true });
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(true);
  });

  it('every uncertain state dispatches: missing event row, tokenless (null owner)', async () => {
    const missing = fakeEnv([], { event: null });
    expect(await suppressionFor(missing.env, 'gone')).toEqual({ suppress: false, mismatch: false });

    // A covert/tokenless trigger has no account at all — the path a survivor uses when
    // she cannot sign in. It must never be classifiable as a test.
    const tokenless = fakeEnv([], { event: { isTest: 1, userId: null }, canary: true });
    const decision = await suppressionFor(tokenless.env, 'e1');
    expect(decision.suppress).toBe(false);
    expect(decision.mismatch).toBe(true);
  });
});

describe('§D the flag is server-derived — a client cannot assert it', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const src = ['../src/index.ts', '../src/lib/canary.ts', '../src/channels/router.ts']
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
    .join('\n');

  it('POST /v1/events derives isTest from the ACCOUNT, never from the request body', () => {
    // The one derivation, spelled out. If someone rewrites this to read a body field,
    // the string below stops matching and this test goes red before the deploy does.
    expect(index).toContain("const isTest = Number(owner?.isCanary ?? 0) === 1 ? 1 : 0;");
    expect(index).toContain("SELECT orgId, isCanary FROM users WHERE id = ?");
  });

  it('no source path anywhere reads a test marking off a request', () => {
    // Body / query / header readers for anything that looks like a client-asserted test
    // flag. `body.isTest`, `c.req.query('isTest')`, `X-Is-Test`, and friends.
    expect(src).not.toMatch(/body\s*\.\s*is_?[Tt]est/);
    expect(src).not.toMatch(/query\(\s*['"]is_?[Tt]est['"]\s*\)/);
    expect(src).not.toMatch(/header\(\s*['"][^'"]*[Tt]est[^'"]*['"]\s*\)/);
  });

  it('users.isCanary is written in exactly one place — the admin provisioning path', () => {
    // Grep the whole worker source, not just the files above: a second writer is a
    // second way for a real account to acquire the flag.
    const all = ['index.ts', 'lib/canary.ts', 'lib/users.ts', 'routes/auth.ts', 'routes/user.ts', 'routes/canary.ts']
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    // WRITES only — `SET isCanary = …`. Reads (`WHERE isCanary = 1`) are harmless and
    // several routes make them; what must stay singular is the number of places that can
    // GRANT the flag, because each one is another way a real account could acquire it.
    const writers = all.match(/SET\s+isCanary\s*=\s*[01]/g) ?? [];
    expect(writers).toHaveLength(1);
    expect(readFileSync(new URL('../src/lib/canary.ts', import.meta.url), 'utf8')).toContain(
      'UPDATE users SET isCanary = 1',
    );
  });
});
