import { describe, expect, it } from 'vitest';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- .mjs test helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';

import {
  boundedJson,
  CAPTURE_PATH,
  clampArray,
  clampString,
  depthWithin,
  LIMITS,
} from '../src/lib/request-bounds';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A stand-in for Hono's request: the two methods boundedJson actually uses. */
function fakeReq(body: string, headers: Record<string, string> = {}) {
  return {
    text: async () => body,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

describe('§A — bounded JSON never throws and always states why', () => {
  it('parses a body inside the bound', async () => {
    const out = await boundedJson<{ a: number }>(fakeReq('{"a":1}'), 1000);
    expect(out.refusal).toBeNull();
    expect(out.value).toEqual({ a: 1 });
  });

  it('refuses on a declared length over the bound WITHOUT reading the body', async () => {
    let read = false;
    const req = {
      text: async () => {
        read = true;
        return 'x';
      },
      header: (n: string) => (n.toLowerCase() === 'content-length' ? String(10_000) : undefined),
    };
    const out = await boundedJson(req, 1000);
    expect(out.refusal).toBe('too_large');
    // The point of the early check: an oversized body is refused before it is pulled into memory.
    expect(read, 'the body was read despite an over-limit Content-Length').toBe(false);
  });

  it('does not trust Content-Length — a lying header is caught by measurement', async () => {
    // A client that declares 10 bytes and sends 10 KB defeats a header-only bound entirely.
    const body = 'y'.repeat(10_000);
    const out = await boundedJson(fakeReq(body, { 'content-length': '10' }), 1000);
    expect(out.refusal).toBe('too_large');
    expect(out.bytes).toBe(10_000);
  });

  it('measures BYTES, not characters', async () => {
    // 400 four-byte characters are 1,600 bytes. A bound measured with `.length` would have let
    // this through at four times the limit it claimed to enforce.
    const body = JSON.stringify({ s: '\u{1F511}'.repeat(400) });
    const out = await boundedJson(fakeReq(body), 1000);
    expect(out.refusal, 'a multi-byte body slipped past a bound measured in characters').toBe('too_large');
  });

  it('returns a refusal rather than throwing on malformed JSON', async () => {
    for (const body of ['', '   ', '{', 'not json', '{"a":']) {
      const out = await boundedJson(fakeReq(body), 1000);
      expect(out.refusal, `body ${JSON.stringify(body)}`).toBe('malformed');
      expect(out.value).toBeNull();
    }
  });

  it('refuses a body nested past the depth limit', async () => {
    const deep = '['.repeat(50) + ']'.repeat(50);
    const out = await boundedJson(fakeReq(deep), 100_000);
    expect(out.refusal).toBe('too_deep');
  });

  it('survives nesting deep enough to overflow a recursive checker', async () => {
    // 200,000 levels. `JSON.parse` itself throws RangeError here, which must surface as a refusal
    // and not as an exception — and the depth check must never be the thing that overflows.
    const pathological = '['.repeat(200_000) + ']'.repeat(200_000);
    const out = await boundedJson(fakeReq(pathological), 10 * 1024 * 1024);
    expect(out.value).toBeNull();
    expect(['malformed', 'too_deep']).toContain(out.refusal);
  });

  it('depthWithin is iterative — a 200k-deep value does not blow the stack', () => {
    let node: unknown = 1;
    for (let i = 0; i < 200_000; i += 1) node = [node];
    expect(() => depthWithin(node, LIMITS.depth)).not.toThrow();
    expect(depthWithin(node, LIMITS.depth)).toBe(false);
  });
});

describe('§A — clamping keeps evidence and reports the loss', () => {
  it('takes the first N and counts what it dropped', () => {
    const { items, dropped } = clampArray<number>(
      Array.from({ length: 900 }, (_, i) => i),
      500,
    );
    expect(items).toHaveLength(500);
    expect(dropped).toBe(400);
    expect(items[0], 'clamping must keep the EARLIEST items — the start of an incident').toBe(0);
  });

  it('treats a non-array as empty rather than throwing', () => {
    for (const v of [null, undefined, 'x', 42, {}]) {
      expect(() => clampArray(v, 10), String(v)).not.toThrow();
      expect(clampArray(v, 10).items).toEqual([]);
    }
  });

  it('clampString truncates and never throws', () => {
    expect(clampString('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(clampString('ab', 3)).toEqual({ text: 'ab', truncated: false });
    for (const v of [null, undefined, 42, {}, []]) {
      expect(() => clampString(v, 10), String(v)).not.toThrow();
      expect(typeof clampString(v, 10).text).toBe('string');
    }
  });
});

describe('§A — the capture-path exemption covers every capture route that exists', () => {
  // Comments STRIPPED. A comment in index.ts that mentions `app.post('/v1/events/:id/...')` —
  // and several now do, explaining this very split — would otherwise be extracted as a phantom
  // route and either fail this guard or, worse, satisfy it.
  const source: string = code(join(SRC, 'index.ts'));

  it('found the source and the middleware — this guard asserts its own landmarks', () => {
    expect(source.length, 'index.ts not found — this guard is reading nothing').toBeGreaterThan(10_000);
    expect(source, 'the capture exemption is no longer applied in the middleware').toContain(
      'CAPTURE_PATH.test(pathname)',
    );
  });

  it('every /v1/events/:id/... POST route is either exempt or deliberately not capture', () => {
    // The consequence of a miss is not theoretical: an ingest route outside the exemption gets the
    // 64 KB ordinary bound and REFUSES a survivor's upload. So the routes are enumerated from the
    // source rather than from memory — and the pattern under test is IMPORTED, not copied, because
    // a copy in the test would have agreed with the mistake it is supposed to catch.
    const pattern = /app\.post\('(\/v1\/events\/:id\/[^']+)'/g;
    const found = [...source.matchAll(pattern)].map((m) => m[1]);
    expect(found.length, 'no event sub-routes matched — the extraction pattern is wrong').toBeGreaterThan(2);

    // Routes that take an event id but carry CONTROL, not evidence: a status change, a signed
    // beacon, a heartbeat. Each is listed explicitly, so adding a new ingest route fails this test
    // rather than silently inheriting a refusal. This list is what the guard actually taught me —
    // `/lost` and `/heartbeat` were both missing from the version I wrote from memory.
    const notIngest = new Set([
      '/v1/events/:id/close',
      '/v1/events/:id/close-request',
      '/v1/events/:id/closure-lockout',
      '/v1/events/:id/closure-request',
      '/v1/events/:id/standdown',
      '/v1/events/:id/lost',
      '/v1/events/:id/heartbeat',
      '/v1/events/:id/origin',
      '/v1/events/:id/reason-triggered',
      '/v1/events/:id/encryption-state',
    ]);

    for (const route of found) {
      const concrete = route.replace(':id', 'evt_x').replace(':sequence', '0');
      const exempt = CAPTURE_PATH.test(concrete);
      if (notIngest.has(route)) {
        expect(exempt, `${route} is listed as control-only but matches the capture exemption`).toBe(false);
      } else {
        expect(
          exempt,
          `${route} carries event data but is NOT exempt — it would be refused at ${LIMITS.jsonBodyBytes} bytes. ` +
            'Either add it to CAPTURE_PATH or list it as control-only.',
        ).toBe(true);
      }
    }
  });

  it('the exemption matches the real route spellings, plural included', () => {
    // The bug this pins: CAPTURE_PATH said `location` where the route is `/locations`, and with a
    // trailing word boundary that never matches. Every location upload would have been refused.
    expect(CAPTURE_PATH.test('/v1/events/evt_x/locations')).toBe(true);
    expect(CAPTURE_PATH.test('/v1/events/evt_x/wrapped-keys')).toBe(true);
    expect(CAPTURE_PATH.test('/v1/events/evt_x/chunks/0')).toBe(true);
    // ...and it does not over-match a control route that merely starts similarly.
    expect(CAPTURE_PATH.test('/v1/events/evt_x/close')).toBe(false);
    expect(CAPTURE_PATH.test('/v1/me/contacts')).toBe(false);
  });

  it('the stated chunk bound is far above a real chunk, not near it', () => {
    // Real captures run ~300 KB per chunk. A bound set close to that would refuse ordinary
    // evidence from a device that recorded a slightly longer segment.
    const OBSERVED_CHUNK_BYTES = 301_056;
    expect(LIMITS.chunkBytes / OBSERVED_CHUNK_BYTES).toBeGreaterThan(20);
  });
});
