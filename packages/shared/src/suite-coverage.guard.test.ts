import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/**
 * Brief 43 §D — EVERY PACKAGE WITH SOURCE IS REACHED BY `pnpm -r test`.
 *
 * The defect this pins was not a failing test. It was a package that declared `build`, `typecheck`
 * and `lint` and no `test`, so the recursive runner walked past it and reported success over code
 * it never executed. What sat in that gap was the certified-report verifier — the artifact a third
 * party runs against a survivor's evidence, in a hearing, with nobody from BLACK BOX present.
 *
 * A test that never runs is the same class as a test that cannot fail: both report a confidence
 * nobody earned, and both stay invisible until the thing they were meant to catch has shipped.
 * The vacuous-test sweep found the second class by reading assertions; this finds the first by
 * reading the runner's own reach, which no amount of reading assertions would have surfaced.
 */
function workspacePackages(): Array<{ name: string; dir: string; pkg: Record<string, unknown> }> {
  const out: Array<{ name: string; dir: string; pkg: Record<string, unknown> }> = [];
  for (const group of ['apps', 'packages', 'workers']) {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, group));
    } catch {
      continue; // a workspace group that does not exist is not a finding
    }
    for (const entry of entries) {
      const dir = join(ROOT, group, entry);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
        out.push({ name: String(pkg.name ?? `${group}/${entry}`), dir, pkg });
      } catch {
        /* not a package */
      }
    }
  }
  return out;
}

/** Does this package actually carry source worth testing? */
function hasSource(dir: string): boolean {
  const walk = (d: string, depth: number): boolean => {
    if (depth > 4) return false;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.wrangler') continue;
      if (/\.(ts|tsx)$/.test(e) && !e.endsWith('.d.ts')) return true;
      if (!e.includes('.') && walk(join(d, e), depth + 1)) return true;
    }
    return false;
  };
  return walk(join(dir, 'src'), 0);
}

describe('the suite reaches every package that has source', () => {
  const packages = workspacePackages();

  it('found the workspace at all — this guard asserts its own landmarks', () => {
    // Without this, a wrong ROOT would enumerate nothing and the guard below would pass over an
    // empty list, which is exactly the vacuous shape it exists to prevent.
    expect(packages.length, 'no workspace packages found — ROOT is wrong').toBeGreaterThan(2);
    expect(packages.map((p) => p.name)).toContain('@blackbox/shared');
  });

  for (const { name, dir, pkg } of packages) {
    it(`${name} declares a test script`, () => {
      if (!hasSource(dir)) return; // nothing to run
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      expect(
        scripts.test,
        `${name} has source but no "test" script, so \`pnpm -r test\` never runs it. ` +
          'Add one — a package outside the suite is untested code that reports as passing.',
      ).toBeTruthy();
    });
  }
});
