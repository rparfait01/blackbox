import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatch, isChannelDeliverable } from '../src/channels/router';
import type { Env } from '../src/types';

/**
 * ONE-DISPATCHER tripwire (notification brief §2/§3).
 *
 * The model: given a recipient, route on their PREFERRED channel, fall back to
 * their other channel automatically on failure, and report "not reached" ONLY
 * once every channel they have has failed. Channels are inputs, not systems.
 *
 * These exercise the REAL dispatch() against a fake D1 and stubbed provider
 * fetches — not a re-implementation of the logic. The failure they exist to catch
 * is a survivor being told nobody could be reached when a working second channel
 * was never tried, and its mirror: a fallback delivery being reported as failure.
 */

/** Endpoints the fake DB will hand back, in stored order. */
type Ep = { channel: string; channelIdentifier: string; priority: number };

function fakeEnv(endpoints: Ep[]): { env: Env; writes: string[] } {
  const writes: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            all: async () =>
              sql.includes('FROM contact_endpoints')
                ? { results: endpoints.map((e, i) => ({ id: `ep${i}`, contactId: 'c1', verifiedAt: null, createdAt: 0, ...e })) }
                : { results: [] },
            first: async () => null,
            run: async () => {
              if (sql.startsWith('INSERT INTO delivery_records')) writes.push('delivery');
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
  return { env, writes };
}

/**
 * Stub the providers by URL. `fail` lists the hosts that should reject.
 *
 * Each provider's REAL success code matters: LINE only treats 200 as delivered
 * (line.ts:140), SendGrid answers 202. Returning a blanket 202 made LINE look
 * broken and silently turned two of these tests into fallback scenarios — the
 * stub has to model the providers honestly or it tests nothing.
 */
function stubFetch(fail: string[]): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const host = url.includes('line.me') ? 'line' : url.includes('sendgrid') ? 'email' : 'other';
    if (fail.includes(host)) {
      return new Response(JSON.stringify({ errors: [{ message: 'provider down' }] }), { status: 401 });
    }
    return host === 'line'
      ? new Response('{}', { status: 200, headers: { 'x-line-request-id': 'lid-1' } })
      : new Response('', { status: 202, headers: { 'x-message-id': 'mid-1' } });
  });
}

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

afterEach(() => vi.unstubAllGlobals());

describe('§2 preferred channel first', () => {
  it('delivers on the preferred channel and does NOT fall back', async () => {
    stubFetch([]);
    const { env } = fakeEnv([
      { channel: 'line', channelIdentifier: 'U123', priority: 1 },
      { channel: 'email', channelIdentifier: 'a@b.c', priority: 2 },
    ]);
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('line');
    expect(r.fellBack).toBe(false);
    // The fallback must not be touched when the preferred channel worked.
    expect(r.attempts).toHaveLength(1);
  });
});

describe('§2 automatic fallback BEFORE any failure is reported', () => {
  it('preferred fails → tries the other channel → reports DELIVERED, not failure', async () => {
    stubFetch(['line']); // LINE down, email fine
    const { env } = fakeEnv([
      { channel: 'line', channelIdentifier: 'U123', priority: 1 },
      { channel: 'email', channelIdentifier: 'a@b.c', priority: 2 },
    ]);
    const r = await dispatch(env, 'c1', message);
    // THE POINT: a fallback delivery is a SUCCESS. Reporting this as "could not
    // reach" would be a lie that costs a survivor their alert.
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('email');
    expect(r.fellBack).toBe(true);
    expect(r.attempts.map((a) => `${a.channel}:${a.ok}`)).toEqual(['line:false', 'email:true']);
  });

  it('order is by stored priority — the preferred channel is tried first', async () => {
    stubFetch(['email']); // email down, line fine — but email is priority 1 here
    const { env } = fakeEnv([
      { channel: 'email', channelIdentifier: 'a@b.c', priority: 1 },
      { channel: 'line', channelIdentifier: 'U123', priority: 2 },
    ]);
    const r = await dispatch(env, 'c1', message);
    expect(r.attempts[0]!.channel).toBe('email');
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('line');
    expect(r.fellBack).toBe(true);
  });
});

describe('§3 "not reached" is honest — only after EVERY channel failed', () => {
  it('all channels fail → delivered false, with the real reason per attempt', async () => {
    stubFetch(['line', 'email']);
    const { env } = fakeEnv([
      { channel: 'line', channelIdentifier: 'U123', priority: 1 },
      { channel: 'email', channelIdentifier: 'a@b.c', priority: 2 },
    ]);
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(false);
    expect(r.channel).toBeNull();
    expect(r.attempts).toHaveLength(2);
    // "Could not reach" must be able to explain itself, never shrug.
    for (const a of r.attempts) {
      expect(a.ok).toBe(false);
      expect(a.reason).toBeTruthy();
    }
  });

  it('a single-channel contact that fails is not reached — nothing to fall back to', async () => {
    stubFetch(['line']);
    const { env } = fakeEnv([{ channel: 'line', channelIdentifier: 'U123', priority: 1 }]);
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(false);
    expect(r.fellBack).toBe(false);
    expect(r.attempts).toHaveLength(1);
  });

  it('a contact with NO endpoints is reported unreachable, never silently ok', async () => {
    stubFetch([]);
    const { env } = fakeEnv([]);
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(false);
    expect(r.attempts).toEqual([]);
  });

  it('every attempt is recorded to D1 — delivery is observable, not guessed', async () => {
    stubFetch(['line']);
    const { env, writes } = fakeEnv([
      { channel: 'line', channelIdentifier: 'U123', priority: 1 },
      { channel: 'email', channelIdentifier: 'a@b.c', priority: 2 },
    ]);
    await dispatch(env, 'c1', message);
    expect(writes.filter((w) => w === 'delivery')).toHaveLength(2);
  });
});

describe('§2 the WhatsApp seam is present but unbuilt', () => {
  it('whatsapp is a known channel that is NOT deliverable (stub, no rebuild needed)', () => {
    const { env } = fakeEnv([]);
    expect(isChannelDeliverable(env, 'whatsapp')).toBe(false);
  });

  it('an unconfigured channel surfaces in the result rather than vanishing', async () => {
    stubFetch([]);
    // No TWILIO_* config in fakeEnv, so sms resolves to a stub and cannot deliver.
    const { env } = fakeEnv([{ channel: 'sms', channelIdentifier: '+819000000', priority: 1 }]);
    const r = await dispatch(env, 'c1', message);
    expect(r.delivered).toBe(false);
    // A silent skip is how a survivor ends up believing someone was told.
    expect(r.attempts.length).toBeGreaterThan(0);
  });
});
