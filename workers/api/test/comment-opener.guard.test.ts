import { describe, expect, it } from 'vitest';

import { readdirSync, statSync } from 'node:fs';

// @ts-expect-error -- .mjs test helper, no type declarations
import { prose } from '../../../test-utils/guard-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The character itself, never written literally in this file — see the test below. */
const BACKTICK = String.fromCharCode(96);
const BACKTICK_G = new RegExp(BACKTICK, 'g');

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

  it('no comment inside a TEMPLATE LITERAL contains a backtick', () => {
    // ═══ THE SECOND MEMBER OF THIS CLASS, AND IT BIT FOUR TIMES IN ONE SESSION. ═════════════
    //
    // `dashboard/page.ts` holds its entire browser client inside a TS template literal. A comment
    // written in there in the ordinary house style — naming an identifier in backticks — puts a
    // backtick into the literal and TERMINATES IT. The failure is a wall of TS1005 "',' expected"
    // pointing at a prose line, which reads as a mangled file rather than a punctuation mark.
    //
    // Same class as the block-comment opener above: a character that is inert in a comment
    // everywhere else, and structural in this one context. The existing guard covered "/*" and
    // not this, so it was rediscovered by hand four separate times.
    const offenders: string[] = [];
    for (const file of files) {
      const raw = prose(file) as string;
      const lines = raw.split(String.fromCharCode(10));
      let inTemplate = false;
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
        if (isComment) {
          if (inTemplate && line.includes(BACKTICK)) {
            offenders.push(`${file.replace(SRC, 'src')}:${i + 1}  ${trimmed.slice(0, 80)}`);
          }
          return; // a comment cannot open or close a literal
        }
        // Count backticks OUTSIDE comments to track whether we are inside a template literal.
        // Crude on purpose: an odd count on a line flips the state, which is exactly how the
        // TypeScript parser sees it, and matching the parser is the whole point.
        const ticks = (line.match(BACKTICK_G) ?? []).length;
        if (ticks % 2 === 1) inTemplate = !inTemplate;
      });
    }
    expect(
      offenders,
      'A comment INSIDE a template literal contains a backtick, which closes the literal. The ' +
        'symptom is a run of TS1005 errors pointing at prose. Name the identifier without ' +
        'backticks in these files.',
    ).toEqual([]);
  });
});
