import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from '../../../test-utils/guard-source.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** Comment-stripped — behaviour, not prose (test-utils/guard-source.mjs). */
const code = (f: string): string => stripComments(readFileSync(join(SRC, f), 'utf8'));

/**
 * Brief 42 §D — the coordinator surface.
 *
 * This is the baseline Brief 33 Fix B §E2 must not weaken. The event-bound token is in the URL
 * PATH, so the referrer policy is the only thing standing between that token and whatever the
 * coordinator clicks next — and until now it was set on Cloudflare Pages, which is a different
 * origin from the one that serves the dashboard.
 */
describe('§D the coordinator cookie is not readable, not sent cross-site, not sent in clear', () => {
  const index = code('index.ts');

  it('bbcoord is HttpOnly, Secure and SameSite', () => {
    const block = index.slice(index.indexOf("setCookie(c, 'bbcoord'"), index.indexOf("setCookie(c, 'bbcoord'") + 300);
    expect(block.length, 'the bbcoord setCookie call was not found').toBeGreaterThan(50);
    expect(block).toMatch(/httpOnly: true/);
    expect(block).toMatch(/secure: true/);
    expect(block).toMatch(/sameSite: '(Lax|Strict)'/);
  });

  it('the cookie carries a claim key, never the magic token itself', () => {
    // The cookie proves WHICH viewer claimed the event. Putting the token in a cookie as well
    // would put it in a second place a browser syncs.
    const block = index.slice(index.indexOf("setCookie(c, 'bbcoord'"), index.indexOf("setCookie(c, 'bbcoord'") + 200);
    expect(block).toMatch(/setCookie\(c, 'bbcoord', newKey/);
  });
});

describe('§D the referrer policy is set by the origin that serves the token-bearing URL', () => {
  const index = code('index.ts');

  it('the WORKER sets Referrer-Policy — Pages _headers does not reach it', () => {
    // The whole point: `_headers` is a Pages file and the dashboard is served by the Worker.
    // A referrer policy on the wrong origin protects nothing.
    expect(index).toMatch(/c\.header\('Referrer-Policy', 'no-referrer'\)/);
  });

  it('no-referrer specifically — the token is in the PATH', () => {
    // strict-origin-when-cross-origin still emits an origin, which is useless here, while any
    // policy that emits a path emits the token. There is no middle setting worth having.
    expect(index).not.toMatch(/strict-origin|origin-when-cross-origin|unsafe-url/);
  });

  it('nosniff and framing denial too, and they run on EVERY response', () => {
    expect(index).toMatch(/c\.header\('X-Content-Type-Options', 'nosniff'\)/);
    expect(index).toMatch(/c\.header\('X-Frame-Options', 'DENY'\)/);
    // Anchored on the middleware that CONTAINS the header, not on the first `app.use('*')` in
    // the file — which is CORS. Assert the property, not the spelling: the previous version
    // sliced the wrong block and reported a failure about code that was correct.
    const at = index.indexOf("c.header('Referrer-Policy'");
    expect(at, 'Referrer-Policy is not set anywhere').toBeGreaterThan(-1);
    const mountAt = index.lastIndexOf("app.use('*'", at);
    expect(mountAt, 'the header is not inside a wildcard mount — a route added later would miss it').toBeGreaterThan(-1);
    const mw = index.slice(mountAt, at + 200);
    expect(mw).toMatch(/X-Content-Type-Options/);
    expect(mw).toMatch(/X-Frame-Options/);
  });

  it('the headers are applied AFTER next(), so a route cannot silently lose them', () => {
    const at = index.indexOf("c.header('Referrer-Policy'");
    const mountAt = index.lastIndexOf("app.use('*'", at);
    const mw = index.slice(mountAt, at);
    expect(mw).toMatch(/await next\(\)/);
  });
});
