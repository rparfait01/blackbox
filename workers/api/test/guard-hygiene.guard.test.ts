import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const debt = JSON.parse(readFileSync(join(ROOT, 'test-utils/unconverted-guards.json'), 'utf8')) as {
  files: string[];
};

const guardFiles = [
  ...readdirSync(join(ROOT, 'apps/pwa/src'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `apps/pwa/src/${f}`),
  ...readdirSync(join(ROOT, 'workers/api/test'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `workers/api/test/${f}`),
];

const readsSource = (rel: string): boolean => /readFileSync/.test(readFileSync(join(ROOT, rel), 'utf8'));
const strips = (rel: string): boolean => /strip\w*\(|from '.*guard-source/.test(readFileSync(join(ROOT, rel), 'utf8'));

/**
 * THE RULE, ENFORCED AS TOOLING RATHER THAN ASKED FOR AS DISCIPLINE.
 *
 * "A guard asserts against parsed structure — AST, exported symbols, config values. Never source
 * text, never comments. A comment is not an interface."
 *
 * Six occurrences taught that the rule does not work as a rule. Every one was written by someone
 * who knew it. So the check is mechanical: a NEW guard that reads source without stripping fails
 * here, and the existing debt is an explicit list that may only shrink.
 *
 * The dangerous direction is not the noisy one. A negative assertion that fails on a comment
 * announces itself. A POSITIVE assertion satisfied by a comment is a guard reporting green while
 * guarding nothing — the same shape as a cost line that always reads zero.
 */
describe('guards assert against parsed structure, not prose', () => {
  it('no NEW guard reads source text without stripping comments', () => {
    const offenders = guardFiles.filter((f) => readsSource(f) && !strips(f) && !debt.files.includes(f));
    expect(
      offenders,
      `these read source without stripping comments — use test-utils/guard-source.mjs (code/prose/json/exportsOf):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the debt list may only shrink — a converted file must be removed from it', () => {
    // Otherwise the list rots into a permanent exemption nobody revisits, which is how an
    // allowlist becomes the thing it was supposed to retire.
    const stale = debt.files.filter((f) => !readsSource(f) || strips(f));
    expect(stale, `these no longer belong on the unconverted list — delete them from it:\n  ${stale.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('every listed file still exists', () => {
    const missing = debt.files.filter((f) => !guardFiles.includes(f));
    expect(missing, 'listed guard files that no longer exist').toEqual([]);
  });

  it('the debt is counted, so it is visible rather than forgotten', () => {
    // Not an assertion about the number — an assertion that the number is stated at all.
    expect(debt.files.length).toBeGreaterThanOrEqual(0);
    console.log(`      [guard hygiene] ${debt.files.length} guard file(s) still match raw source text`);
  });
});
