import { describe, expect, it } from 'vitest';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- .mjs test helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';

import { readConsistent } from '../src/lib/consistent-read';
import type { Env } from '../src/types';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * A GATE READS FROM THE PRIMARY. A refusal decided on a replica may already be false.
 *
 * `countActiveAdmins` gates seat issuance. Read from a replica, it told an org "Add a second
 * admin before enrolling survivors" immediately after they added one — a refusal they could do
 * nothing about and no indication it would pass on retry. It surfaced as an intermittent
 * acceptance failure that passed in isolation, which is how a real defect hides as a flaky test.
 */
describe('gates read from the primary', () => {
  it('countActiveAdmins does not read the default binding', () => {
    const src: string = code(join(SRC, 'lib', 'org.ts'));
    const start = src.indexOf('export async function countActiveAdmins');
    expect(start, 'countActiveAdmins not found — this guard is reading nothing').toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body, 'the admin count reads the default binding — a replica can refuse a valid org').toContain(
      'readConsistent',
    );
    expect(body, 'a raw env.DB read remains in the gate').not.toMatch(/env\.DB\.prepare/);
  });

  it('uses first-primary, not an unconstrained session', () => {
    // `first-unconstrained` allows the first read to land on a replica, which is exactly the
    // failure. Only `first-primary` guarantees the gate sees every committed write.
    const lib: string = code(join(SRC, 'lib', 'consistent-read.ts'));
    expect(lib).toContain("'first-primary'");
    expect(lib, 'an unconstrained session cannot fix a stale gate').not.toContain('first-unconstrained');
  });

  it('falls back rather than failing when sessions are unavailable', async () => {
    // A runtime without sessions must still answer. Falling back to the ordinary binding is the
    // behaviour that existed before — no worse, and never an error the caller has to handle.
    const calls: string[] = [];
    const noSessions = {
      DB: {
        prepare: (q: string) => {
          calls.push(q);
          return { bind: () => ({ first: async () => ({ n: 2 }) }) };
        },
      },
    } as unknown as Env;
    const out = await readConsistent(noSessions, (db) =>
      db.prepare('SELECT 1').bind().first<{ n: number }>(),
    );
    expect(out).toEqual({ n: 2 });
    expect(calls.length, 'the fallback did not run the query').toBe(1);
  });

  it('uses the session when the runtime provides one', async () => {
    let constraint: string | null = null;
    const withSessions = {
      DB: {
        withSession: (c: string) => {
          constraint = c;
          return { prepare: () => ({ bind: () => ({ first: async () => ({ n: 9 }) }) }) };
        },
        prepare: () => {
          throw new Error('the default binding was used despite a session being available');
        },
      },
    } as unknown as Env;
    const out = await readConsistent(withSessions, (db) => db.prepare('SELECT 1').bind().first<{ n: number }>());
    expect(out).toEqual({ n: 9 });
    expect(constraint).toBe('first-primary');
  });
});
