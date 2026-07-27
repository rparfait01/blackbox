import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 0B — closure consent scales to the parties actually ENGAGED, and the CLIENT must
 * render what that one model decided.
 *
 * THE REGRESSION THIS PINS. Brief 0B fixed the model on the server: with nobody engaged,
 * the survivor's own assent closes the event immediately. The client was never updated.
 * It hardcoded `return 'awaiting'`, its result type could not express a completed close,
 * and its doc comment still asserted the pre-0B rule ("the user can never close the alert
 * themselves; a coordinator confirms"). So an account with NO support contact closed
 * instantly on the server and was told on screen that "your support contact will
 * confirm" — waiting forever on a party that does not exist.
 *
 * There is ONE closure model. These assert the client consumes it rather than
 * re-implementing or ignoring it.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the client consumes the model instead of assuming an answer', () => {
  const closure = read('./lib/closure/index.ts');
  const code = stripComments(closure);

  it('the result type can express a completed close', () => {
    expect(code).toMatch(/export type ClosureResult = 'closed' \| 'awaiting' \| 'no-session'/);
  });

  it('it READS the server verdict — never hardcodes awaiting', () => {
    expect(code).toMatch(/res\.json\(\)/);
    expect(code).toMatch(/data\?\.closed === true/);
    // The exact shape of the bug: postClosureRequest returning void, so the verdict was
    // discarded and 'awaiting' was the only value the function could ever produce.
    expect(code).not.toMatch(/async function postClosureRequest\([\s\S]{0,400}\): Promise<void>/);
    expect(code).toMatch(/async function postClosureRequest\([\s\S]{0,400}Promise<\{ closed: boolean \}>/);
  });

  it('a failure or unreadable answer degrades to awaiting, never to a false "secured"', () => {
    // Telling a survivor she is secured when the server never said so is the one
    // direction this must never fail in.
    expect(code).toMatch(/catch[\s\S]{0,200}return 'awaiting'|closed\)[\s\S]{0,300}return 'awaiting'/);
    expect(code).toMatch(/return 'awaiting';\s*\n\}/);
  });

  it('a confirmed close tears down the local session so the app leaves the alert', () => {
    expect(code).toMatch(/closed\)[\s\S]{0,200}closeAllActiveSessions/);
  });

  it('the stale pre-0B claim is gone from the doc', () => {
    expect(closure).not.toMatch(/user can NEVER close the alert themselves/i);
  });
});

describe('the overlay renders both outcomes, and the waiting copy is now true', () => {
  const control = read('./routes/meditation/ClosureControl.tsx');

  it('a confirmed close shows an ended session, not "awaiting confirmation"', () => {
    expect(control).toMatch(/result === 'closed'[\s\S]{0,200}setSecured\(true\)/);
    expect(control).toMatch(/\{secured \?/);
  });

  it('"your support contact will confirm" is reachable ONLY when awaiting', () => {
    const securedAt = control.indexOf('{secured ? (');
    const awaitingAt = control.indexOf(') : awaiting ? (');
    const elseAt = control.indexOf(') : (', awaitingAt);
    expect(securedAt).toBeGreaterThan(-1);
    expect(awaitingAt).toBeGreaterThan(securedAt);
    expect(elseAt).toBeGreaterThan(awaitingAt);
    // The waiting copy lives in the awaiting branch, and ONLY there — it is now a true
    // statement, because that branch is reached only when support is actually engaged.
    expect(control.slice(awaitingAt, elseAt)).toMatch(/support contact will confirm/);
    expect(control.slice(securedAt, awaitingAt)).not.toMatch(/support contact will confirm|awaiting confirmation/);
  });

  it('neither outcome branches on the gesture', () => {
    // The rendered tree must not read `sat` at all — it is an input to submit(), never
    // to a view. Slice from the JSX return (the overlay root), not the earlier
    // cleanup-callback `return (`.
    // Strip comments first: the branch legitimately DOCUMENTS the invariant ("identical
    // for sat and unsat"). What must be absent is code reading the gesture.
    const render = stripComments(control.slice(control.indexOf('<div\n      className="fixed inset-0')));
    expect(render.length).toBeGreaterThan(0);
    expect(render).not.toMatch(/\bsat\b/);
  });
});
