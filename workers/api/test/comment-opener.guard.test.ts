import { describe, expect, it } from 'vitest';

import { readdirSync, statSync } from 'node:fs';

// @ts-expect-error -- .mjs test helper, no type declarations
import { prose } from '../../../test-utils/guard-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * NO COMMENT CONTAINS A PHANTOM BLOCK-COMMENT OPENER.
 *
 * Writing a route glob like `/v1/c/` followed by a star inside a `//` comment puts the two
 * characters `/` `*` into the file. Every comment stripper — ours in `guard-source.mjs`, and any
 * other regex-based one — reads that as the START of a block comment and deletes everything up to
 * the next `*` `/`, which may be hundreds of lines away.
 *
 * MEASURED, not hypothesised: one such comment in `index.ts` removed roughly 10KB of code from
 * the stripped view. `setCookie(c, 'bbcoord', ...)` vanished, and the guard asserting that cookie
 * is HttpOnly and Secure failed with "the call was not found".
 *
 * That failure was loud, and it is the lucky direction. The dangerous one is a POSITIVE assertion
 * whose subject disappears — the guard then reports green while guarding nothing, which is the
 * same shape as a cost line that always reads zero.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('comments do not open phantom block comments', () => {
  const files = sourceFiles(SRC);

  it('found the source tree — this guard asserts its own landmarks', () => {
    expect(files.length, 'no source files found').toBeGreaterThan(10);
    expect((prose(files[0]) as string).length, 'prose() read nothing').toBeGreaterThan(50);
  });

  it('no line comment contains a block-comment opener', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // `prose()` — the deliberate RAW read. Stripping here would delete the comments this guard
      // exists to inspect, which is the one case where reading stripped source is the wrong tool.
      (prose(file) as string)
        .split('\n')
        .forEach((line, i) => {
          const trimmed = line.trim();
          // Line comments, and the continuation lines of a JSDoc block.
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
          if (isComment && line.includes('/*')) {
            offenders.push(`${file.replace(SRC, 'src')}:${i + 1}  ${trimmed.slice(0, 80)}`);
          }
        });
    }
    expect(
      offenders,
      'A comment contains "/*", which every regex comment stripper reads as a block-comment ' +
        'opener — it will delete code up to the next "*/" from the stripped view, and a guard ' +
        'asserting on that code will either fail mysteriously or pass over nothing. Write the ' +
        'path without the glob.',
    ).toEqual([]);
  });
});
