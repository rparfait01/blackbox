import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- .mjs test helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';

import { VIEW_COOKIE_OPTS, tokenDisposition } from '../src/lib/coordinator-session';
import type { Env } from '../src/types';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Brief 33 Fix B — THE COORDINATOR'S TOKEN IS NOT IN THE URL, AND NOT ON THE WIRE.
 *
 * The exposure was never only the address bar. Every dashboard API call and the WebSocket
 * handshake carried `?t=<token>`, so the credential sat in every request line and every proxy log
 * for the duration of a live alert. The address bar was simply the part a person could see.
 *
 * The coordinator is typically the survivor's closest contact, plausibly on a shared device,
 * plausibly in the same household as the person the alert is about. A URL in that browser's
 * history discloses that an alert happened, to whoever opens it next.
 */
describe('Brief 33 Fix B — coordinator link exposure', () => {
  const page: string = code(join(SRC, 'dashboard', 'page.ts'));
  const index: string = code(join(SRC, 'index.ts'));

  it('read the sources — this guard asserts its own landmarks', () => {
    expect(page.length, 'dashboard page not read').toBeGreaterThan(5000);
    expect(index.length, 'index not read').toBeGreaterThan(10000);
    expect(index, 'the token/cookie exchange is gone').toContain('createViewSession');
  });

  it('the API helper does not hardcode the token into every request', () => {
    // Before: `var base=CFG.base, q='?t='+encodeURIComponent(CFG.token);` — unconditional, so
    // every call and the socket carried it. Now the query is a FALLBACK, used only when the
    // exchange did not happen (cookie blocked, store down), which §B requires it to survive.
    expect(page, 'the token is still unconditionally appended to every API call').not.toMatch(
      /q\s*=\s*'\?t='\s*\+\s*encodeURIComponent\(CFG\.token\)\s*;/,
    );
    expect(page, 'the conditional fallback is missing — a blocked cookie would lock a coordinator out').toMatch(
      /q\s*=\s*CFG\.token\s*\?/,
    );
  });

  it('the tokened entry redirects rather than rendering, so history keeps no token', () => {
    // An HTTP redirect leaves only the destination in the back stack. That is what keeps the
    // tokened URL out of history, autocomplete and cross-device sync — and it costs no
    // interstitial and no JavaScript, which §0 requires above everything this brief fixes.
    expect(index, 'no redirect to a bare /c/:id — the token stays in the address bar').toMatch(
      /c\.redirect\(`\/c\/\$\{encodeURIComponent\(eventId\)\}`/,
    );
  });

  it('§E2 — the view cookie is HttpOnly, Secure, and not SameSite=Strict', () => {
    // HttpOnly and Secure are non-negotiable. SameSite must NOT be 'Strict': the coordinator
    // arrives by tapping a link in an SMS or mail client, which is a cross-site top-level
    // navigation — under Strict the cookie is withheld on exactly that request and they would
    // land on an error instead of the event.
    expect(VIEW_COOKIE_OPTS.httpOnly).toBe(true);
    expect(VIEW_COOKIE_OPTS.secure).toBe(true);
    expect(VIEW_COOKIE_OPTS.sameSite).toBe('Lax');
  });

  it('§E3 — redemption is not a claim', () => {
    // Brief 7 locked coordination to a deliberate POST because merely opening a link must never
    // claim it; duress would otherwise route to whoever opened first. The redeem handler must not
    // touch the claim state.
    const redeemStart = index.indexOf("app.post('/v1/c/:id/redeem'");
    expect(redeemStart, 'redeem route not found').toBeGreaterThan(0);
    const handler = index.slice(redeemStart, index.indexOf('app.post', redeemStart + 10));
    expect(handler, 'redeeming a view session claims coordination').not.toMatch(/coordinatorClaimedAt|bbcoord/);
  });

  it('§B — an unreachable store reports UNBOUND, never refused', async () => {
    // The fail-open direction, asserted rather than described. A coordinator refused because OUR
    // store is down is the worst outcome on this path: they cannot help, and nothing they do
    // fixes it.
    const brokenEnv = {
      DB: {
        prepare: () => {
          throw new Error('store unavailable');
        },
      },
    } as unknown as Env;
    const verdict = await tokenDisposition(brokenEnv, {
      eventId: 'e',
      token: 't',
      presentedSessionKey: 'whatever',
    });
    expect(verdict.state, 'a store outage refused a coordinator').toBe('unbound');
  });

  it('§B — only a DIFFERENT browser is refused; the same one succeeds', async () => {
    const env = (redeemedBy: string) =>
      ({
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => ({ sessionKey: redeemedBy, redeemedAt: 1 }),
            }),
          }),
        },
      }) as unknown as Env;

    const same = await tokenDisposition(env('sess-A'), { eventId: 'e', token: 't', presentedSessionKey: 'sess-A' });
    expect(same.state, 'the browser that redeemed was refused its own link').toBe('bound_to_self');

    const other = await tokenDisposition(env('sess-A'), { eventId: 'e', token: 't', presentedSessionKey: 'sess-B' });
    expect(other.state, 'a spent link was honoured in a different browser').toBe('bound_elsewhere');

    // No cookie at all — a fresh browser presenting a spent link. Also refused, with self-service.
    const none = await tokenDisposition(env('sess-A'), { eventId: 'e', token: 't', presentedSessionKey: null });
    expect(none.state).toBe('bound_elsewhere');
  });

  it('the token is never stored — the SCHEMA has no column that could hold one', () => {
    // A table of live magic tokens for every open event would be a worse asset than the URL
    // exposure this brief closes. Asserted against the DDL rather than the insert statement: the
    // guarantee is that no column EXISTS to put one in, which no amount of careless SQL can undo.
    //
    // (An earlier version regexed from VALUES to the nearest semicolon and matched `input.token`
    // inside the bind call — a guard failing on the very line that hashes the token.)
    const ddl = readFileSync(join(SRC, '..', 'migrations', '0062_coordinator_view_sessions.sql'), 'utf8').replace(
      /--[^\n]*/g,
      ' ',
    );
    const body = ddl.slice(ddl.indexOf('CREATE TABLE'), ddl.indexOf(');'));
    const columns = body
      .split(',')
      .map((line) => (/^\s*([A-Za-z_]\w*)\s+/.exec(line) ?? [])[1])
      .filter(Boolean);
    expect(columns, 'the DDL did not parse').toContain('tokenHash');
    expect(columns, 'a column exists that could hold a raw magic token').not.toContain('token');
    expect(code(join(SRC, 'lib', 'coordinator-session.ts'))).toContain('hashToken');
  });
});
