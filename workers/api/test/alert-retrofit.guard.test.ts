import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from '../../../test-utils/guard-source.mjs';
import { ALERT_TYPES } from '../src/lib/operator-alert';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
/** Comment-stripped — behaviour, not prose (test-utils/guard-source.mjs). */
const code = (f: string): string => stripComments(readFileSync(f, 'utf8'));

/**
 * Brief 35 Fix B §D — THE RETROFIT, checked mechanically.
 *
 * "An alert not on the reported list is an alert that still goes nowhere." The channel existing
 * proves nothing; what matters is that the call sites use it. An error-level `console.log` with no
 * accompanying `operatorAlert` is an alert that still fires into a log nobody watches — which is
 * the exact defect §D exists to close, surviving inside the fix for it.
 */
describe('every error-level alert reaches the channel', () => {
  const files = walk(SRC).filter((f) => !f.endsWith('.test.ts'));

  it('no source file raises an error-level ALERT without also calling operatorAlert', () => {
    const orphans: string[] = [];
    for (const f of files) {
      const src = code(f);
      // An "alert" is an error-level structured log that names an alert. Plain error logging of
      // an internal failure is not in scope; a named alert is a signal meant for a human.
      const hasNamedAlert = /level: 'error'[\s\S]{0,200}?alert: '/.test(src);
      if (hasNamedAlert && !/operatorAlert\(/.test(src)) orphans.push(f.replace(SRC, 'src'));
    }
    expect(orphans, `these raise a named error-level alert that goes nowhere:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('every alert type the channel declares is actually raised somewhere', () => {
    // The mirror failure: a declared type nothing emits is a list that reads as coverage while
    // covering nothing — the same shape as a verdict with no code path that produces it.
    const all = files.map(code).join('\n');
    const deployRaised = new Set(['deploy_gate_unavailable', 'deploy_gate_quota_exceeded']);
    const unraised = ALERT_TYPES.filter((t) => !deployRaised.has(t) && !all.includes(`'${t}'`));
    expect(
      unraised,
      `declared but never raised (a list that reads as coverage): ${unraised.join(', ')}`,
    ).toEqual([]);
  });

  it('the named alerts §D lists are all wired', () => {
    const all = files.map(code).join('\n');
    for (const t of [
      'canary_flag_on_non_canary_account',
      'routable_contact_on_canary_account',
      'seal_pending_beyond_threshold',
      'vault_backlog',
      'sustained_rate_limiting',
      'request_headroom_low',
      'environment_indeterminate',
      'limiter_store_failed_open',
    ]) {
      // No regex: the escaping for a literal paren has been mangled by tooling three times in
      // this session alone, and a guard whose own pattern is wrong proves nothing. Split on the
      // call and look for the type in the argument list that follows.
      const calls = all.split('operatorAlert(').slice(1);
      const wired = calls.some((c) => c.slice(0, 200).includes(`'${t}'`));
      expect(wired, `§D requires ${t} to be raised through operatorAlert`).toBe(true);
    }
  });

  it('alerts on latency-sensitive paths are not awaited into the request', () => {
    // Scoped to the HOT PATHS rather than the whole file. The admin probe endpoint awaits
    // deliberately — it exists to report what the channel did — and a guard that forbade every
    // inline await would be broader than the rule it enforces, which is how a guard starts
    // failing on changes it does not govern.
    const index = code(join(SRC, 'index.ts'));
    // CODE landmarks, not comments. The first attempt bounded these with
    // `indexOf('// Structured request logging')` — which `code()` had already stripped, so the
    // slice ran to the end of the file and swallowed the admin endpoint. A comment is not an
    // interface, and this is the second time that exact mistake has been made inside a guard
    // written to enforce it.
    const between = (from: string, to: string): string => {
      const a = index.indexOf(from);
      const b = index.indexOf(to, a + 1);
      expect(a, `landmark not found: ${from}`).toBeGreaterThan(-1);
      expect(b, `landmark not found: ${to}`).toBeGreaterThan(a);
      return index.slice(a, b);
    };
    const hot = [
      // the abuse limiter middleware: an attacker must not add latency by tripping it
      between('const rule = ruleFor(pathname', 'async function identifierForLimit'),
      // the capture path
      between("app.post('/v1/events/:id/chunks/:sequence'", 'const tz = await eventTzOffset'),
    ];
    for (const region of hot) {
      expect(region.length, 'hot-path region not found — the guard is looking at nothing').toBeGreaterThan(100);
      // THE PROPERTY IS "the request is not delayed", not "the word await is absent". An
      // `await operatorAlert(...)` inside `waitUntil(async () => ...)` is deferred and correct;
      // a bare textual match called that a violation. So: every alert raised in a hot region must
      // have a waitUntil shortly before it. A heuristic, and said to be one — but it tests the
      // thing that matters instead of a spelling.
      let from = 0;
      for (;;) {
        const at = region.indexOf('operatorAlert(', from);
        if (at === -1) break;
        const preceding = region.slice(Math.max(0, at - 400), at);
        expect(preceding, `an alert on a hot path is not deferred (offset ${at})`).toMatch(/waitUntil\(/);
        from = at + 1;
      }
    }
    expect(index).toMatch(/waitUntil\(/);
  });
});
