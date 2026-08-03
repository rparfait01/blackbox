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
    // The capture path and the limiter must not slow down because an alert is being raised —
    // and an attacker must not be able to add latency by triggering one.
    const index = code(join(SRC, 'index.ts'));
    const inline = index.match(/await operatorAlert\(/g) ?? [];
    expect(inline, 'index.ts must raise alerts via waitUntil, not inline await').toEqual([]);
    expect(index).toMatch(/waitUntil\(\s*operatorAlert\(/);
  });
});
