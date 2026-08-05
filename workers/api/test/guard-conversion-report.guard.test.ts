import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BRIEF 54 §A — THE CONVERSION LEDGER, REPORT ONLY.
 *
 * ═══ WHY THIS FAILS NOTHING ══════════════════════════════════════════════════════════════════
 *
 * §0 established that ~48% of the guard estate is BEHAVIOURAL — tests written as regexes over
 * source — and that converting those to AST checks would "preserve a weak form of a strong
 * property". They need to become real tests and the guards deleted, which is engineering work,
 * not a toolkit swap. A meta-guard that FAILED on unconverted files would therefore demand the
 * wrong thing loudly, every run, until someone silenced it.
 *
 * So this reports. It prints the estate, its shape, and what remains, and it asserts only two
 * things that are genuinely invariant: the ledger is honest about what it contains, and the
 * number of source-text guards never goes UP.
 *
 * ═══ THE ONE RATCHET ═════════════════════════════════════════════════════════════════════════
 *
 * A conversion project with no ratchet converts three files and then grows a fourth. The count
 * below may fall and may not rise. That is the whole enforcement, and it is deliberately the
 * weakest thing that still prevents backsliding.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/**
 * The high-water mark. This may only be REDUCED.
 *
 * Set from the estate as it stands after console-boundary was converted as §A's structural
 * model. Lower it as files convert; raising it is the thing this exists to make somebody
 * argue for.
 */
const MAX_TEXT_READING_GUARDS = 61;

function guardFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'coverage') continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith('.guard.test.ts')) out.push(full);
    }
  };
  for (const root of ['apps', 'workers', 'packages']) walk(join(REPO, root));
  return out.sort();
}

/** Does this guard read source as TEXT anywhere? */
function readsText(src: string): boolean {
  return /readFileSync\s*\(/.test(src) || /\b(code|prose|json)\s*\(/.test(src);
}

/** Does it use the AST toolkit? */
function usesAst(src: string): boolean {
  return /guard-ast\.mjs/.test(src);
}

describe('Brief 54 §A — guard estate, reported', () => {
  const files = guardFiles();

  it('the estate is found — this report asserts over something', () => {
    // The failure this prevents: a walk that silently returns nothing and reports a clean estate.
    expect(files.length, 'no guard files found — the walker is broken, not the estate').toBeGreaterThan(40);
  });

  it('prints the ledger', () => {
    const rows = files.map((f) => {
      const src = readFileSync(f, 'utf8');
      return {
        file: relative(REPO, f).replace(/\\/g, '/'),
        text: readsText(src),
        ast: usesAst(src),
        assertions: (src.match(/expect\(/g) ?? []).length,
      };
    });
    const converted = rows.filter((r) => r.ast);
    const textOnly = rows.filter((r) => r.text && !r.ast);
    const neither = rows.filter((r) => !r.text && !r.ast);

    const lines = [
      '',
      '═══ GUARD ESTATE ═══════════════════════════════════════════════════════════════',
      `  files                       ${rows.length}`,
      `  assertions                  ${rows.reduce((n, r) => n + r.assertions, 0)}`,
      '',
      `  using the AST toolkit       ${converted.length}`,
      `  reading source as text      ${textOnly.length}`,
      `  neither (pure unit-style)   ${neither.length}`,
      '',
      '  CONVERTED:',
      ...converted.map((r) => `    ${r.file}  (${r.assertions})`),
      '',
      '  REMAINING, largest first:',
      ...textOnly
        .sort((a, b) => b.assertions - a.assertions)
        .slice(0, 15)
        .map((r) => `    ${r.assertions.toString().padStart(4)}  ${r.file}`),
      `    …and ${Math.max(0, textOnly.length - 15)} more`,
      '════════════════════════════════════════════════════════════════════════════════',
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('THE RATCHET: the number of text-reading guards never rises', () => {
    const textOnly = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return readsText(src) && !usesAst(src);
    });
    expect(
      textOnly.length,
      `Text-reading guards rose to ${textOnly.length} (ceiling ${MAX_TEXT_READING_GUARDS}). A new ` +
        'guard that reads source as text adds to a backlog Brief 54 exists to drain. Use ' +
        'test-utils/guard-ast.mjs, or write a real test — and if neither fits, lower this ' +
        'ceiling in the same commit that argues why.',
    ).toBeLessThanOrEqual(MAX_TEXT_READING_GUARDS);
  });

  it('the ceiling is not slack — it tracks the real count', () => {
    // A ratchet set far above the truth ratchets nothing. This keeps the two within sight of
    // each other, so lowering the ceiling is part of converting rather than an afterthought.
    const textOnly = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return readsText(src) && !usesAst(src);
    });
    expect(
      MAX_TEXT_READING_GUARDS - textOnly.length,
      'the ceiling has drifted above the real count — lower it',
    ).toBeLessThanOrEqual(3);
  });
});
