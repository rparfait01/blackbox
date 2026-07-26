import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 33b §0a — the console must not exist, in any form, inside the Hidden facade.
 *
 * The facade is the whole covert premise: an account that happens to be an org admin, a
 * coordinator, or the operator must render EXACTLY the same meditation app as everyone
 * else. A "console" link, a DEV badge, or an org word on that surface is a tell — and a
 * tell on the facade is the failure mode the facade exists to prevent.
 *
 * These also pin the console's own client-side properties: it renders what the server
 * sent and nothing more, its destructive actions take two deliberate presses, and its
 * roster has no field into which a name could be rendered even if one arrived.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CONSOLE_WORDS = /console|operator|\bDEV\b|maintenance|platform_role|enrollment|coordinator|\bseats?\b/i;

describe('§0a the Hidden facade shows nothing about the console', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface renders console / operator / seat wording', () => {
    for (const f of facades) {
      expect(stripComments(read(f)), `${f} must not mention the console`).not.toMatch(CONSOLE_WORDS);
    }
  });

  it('no facade surface imports or links the console', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not reference the console`).not.toMatch(/routes\/console|['"]\/console['"]/);
    }
  });
});

describe('the console is reachable only by typing its path', () => {
  const router = read('./app/router.tsx');

  it('is registered explicitly, before the catch-all', () => {
    const consoleAt = router.indexOf("path: '/console'");
    const catchAll = router.indexOf("path: '*'");
    expect(consoleAt).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(consoleAt);
  });

  it('nothing in the survivor app navigates to it', () => {
    const survivorSurfaces = [
      './routes/settings/Settings.tsx',
      './routes/blackbox/BlackBoxHome.tsx',
      './routes/onboarding/Onboarding.tsx',
      './routes/signin/SignIn.tsx',
      './app/RootGate.tsx',
    ];
    for (const f of survivorSurfaces) {
      expect(read(f), `${f} must not link the console`).not.toMatch(/['"]\/console['"]/);
    }
  });
});

describe('the console renders what the server decided — it does not decide', () => {
  const src = read('./routes/console/Console.tsx');

  it('panel visibility comes from the server’s `may` object, never from a local rule', () => {
    // Every panel is gated on me.may.*, which the SERVER computed. The client never
    // derives permission from the level string itself.
    for (const key of ['orgs', 'seats', 'codes', 'roster', 'accounts', 'maintenance']) {
      expect(src, `panel ${key} is not gated on the server's decision`).toMatch(
        new RegExp(`me\\.may\\.${key} \\?`),
      );
    }
  });

  it('the issuable code roles come from the server, not a client table', () => {
    expect(src).toMatch(/me\.may\.issueRoles/);
    // No client-side map of "which level may issue what" — that rule lives on the server.
    expect(src).not.toMatch(/CODE_TYPES|const\s+ISSUABLE/);
  });

  it('a refusal is surfaced honestly, never as an empty table', () => {
    expect(src).toMatch(/Server refused \(\$\{res\.status\}\)/);
    expect(src).toMatch(/<Deny>\{error\}<\/Deny>/);
  });
});

describe('destructive console actions take two deliberate presses', () => {
  const src = read('./routes/console/Console.tsx');

  it('the R2 purge cannot be confirmed before a dry run has been seen', () => {
    expect(src).toMatch(/disabled=\{purgeBusy \|\| !purge\}[\s\S]{0,80}runPurge\(true\)/);
  });

  it('account deletion cannot be confirmed before a preview, and demands a reason', () => {
    expect(src).toMatch(/disabled=\{!preview\}[\s\S]{0,80}confirmDelete\(\)/);
    expect(src).toMatch(/confirmDelete[\s\S]{0,300}window\.prompt/);
  });

  it('no destructive action fires from an effect — every one is a click', () => {
    for (const fn of ['runPurge', 'confirmDelete', 'remove', 'revoke']) {
      expect(src, `${fn} must not run on mount`).not.toMatch(new RegExp(`useEffect\\([\\s\\S]{0,160}\\b${fn}\\(`));
    }
  });
});

describe('the roster has no field a name could be rendered into', () => {
  const src = read('./routes/console/Console.tsx');

  it('the row type carries a code, a date and counters — nothing identifying', () => {
    const start = src.indexOf('interface RosterRow');
    const end = src.indexOf('function RosterPanel');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const shape = src.slice(start, end);
    expect(shape).toMatch(/code: string/);
    expect(shape).not.toMatch(/name|email|phone|userId|lat|lon|location/i);
  });

  it('the roster table renders no column that could hold an identity', () => {
    const panel = src.slice(src.indexOf('function RosterPanel'), src.indexOf('// §3 MAINTENANCE'));
    expect(panel).toMatch(/Enrollment code/);
    expect(panel).not.toMatch(/r\.(name|email|phone|userId)/);
  });
});
