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

  it('nothing in the survivor app navigates to it except the gated Settings door', () => {
    const survivorSurfaces = [
      './routes/blackbox/BlackBoxHome.tsx',
      './routes/onboarding/Onboarding.tsx',
      './routes/signin/SignIn.tsx',
      './app/RootGate.tsx',
      // The meditation facade is covered separately and must never link it at all.
      './routes/meditation/MeditationHome.tsx',
    ];
    for (const f of survivorSurfaces) {
      expect(read(f), `${f} must not link the console`).not.toMatch(/['"]\/console['"]/);
    }
  });
});

describe('§0a the Settings door is gated on BOTH the server role and the Visible skin', () => {
  const settings = read('./routes/settings/Settings.tsx');

  it('the level is fetched from the server, never inferred on the client', () => {
    expect(settings).toMatch(/api<\{ level: string; levelLabel: string \}>\('\/v1\/console\/me'\)/);
    // No client-side derivation of a role from the cached user or the token.
    expect(settings).not.toMatch(/platform_role|org_members|isOperator/);
  });

  it('fails CLOSED — an unmarked level, or any failed request, yields no door', () => {
    expect(settings).toMatch(/r\.ok && r\.data && r\.data\.level !== 'unmarked' \? r\.data\.levelLabel : null/);
    // The state starts null, so nothing renders before the server has answered.
    expect(settings).toMatch(/useState<string \| null>\(null\)/);
  });

  it('renders ONLY in the Visible skin — Settings is reachable from the Hidden gear', () => {
    // The covert facade's gear opens THIS screen, so a door gated on role alone would
    // put the word "Console" in front of a covert user. Both conditions, one expression.
    expect(settings).toMatch(/\{present && consoleLevel \? \(/);
    // …and `present` is the Visible-skin flag, not something else that happens to be true.
    expect(settings).toMatch(/const present = selectedMode === 'direct';/);
  });

  it('the door is a Link to /console — no client-side permission logic behind it', () => {
    const door = settings.slice(settings.indexOf('{present && consoleLevel ?'), settings.indexOf(') : null}', settings.indexOf('{present && consoleLevel ?')));
    expect(door).toMatch(/to="\/console"/);
    // It renders the level the SERVER returned; it does not compute a label.
    expect(door).toMatch(/\{consoleLevel\}/);
  });
});

describe('the console renders what the server decided — it does not decide', () => {
  const src = read('./routes/console/Console.tsx');

  it('the visible section is VALIDATED against the nav the server sent', () => {
    // The client does not decide which sections exist for a level — it checks the
    // requested one against me.nav, which the SERVER built, and falls back to home.
    expect(src).toMatch(/me\.nav\.some\(\(n\) => n\.key === requested\) \? requested : ''/);
    // Each panel renders on its own validated section, never on a client-side rule.
    for (const key of ['orgs', 'seats', 'codes', 'roster', 'accounts', 'maintenance']) {
      expect(src, `panel ${key} is not gated on the validated section`).toMatch(
        new RegExp(`section === '${key}' \\?`),
      );
    }
  });

  it('the nav itself is rendered from the server’s list, never a client-side table', () => {
    expect(src).toMatch(/nav\.map\(\(item\) =>/);
    // No hardcoded per-level menu anywhere in the client.
    expect(src).not.toMatch(/const\s+NAV_(ITEMS|BY_LEVEL)|NAV\s*[:=]\s*\{\s*operator/);
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

describe('no dead ends — every console view has a way out', () => {
  const src = read('./routes/console/Console.tsx');

  it('the nav renders on EVERY view, not only on home', () => {
    // <ConsoleNav> sits in the shell, outside the per-section switch, so every section
    // renders with it. If it moved inside a section branch this would fail.
    const shell = src.slice(src.indexOf('function ConsoleShell'), src.indexOf('// ENTRY —'));
    expect(shell).toMatch(/<ConsoleNav nav=\{me\.nav\} section=\{section\} \/>/);
    const navAt = shell.indexOf('<ConsoleNav');
    const firstSectionAt = shell.indexOf("{section === ''");
    expect(navAt).toBeGreaterThan(-1);
    expect(navAt).toBeLessThan(firstSectionAt);
  });

  it('every view carries a way back to the app, and sub-views also return to console home', () => {
    const shell = src.slice(src.indexOf('function ConsoleNav'), src.indexOf('// ENTRY —'));
    // The way OUT of the console is in the persistent nav — so it is on every view.
    expect(src.slice(src.indexOf('function ConsoleNav'), src.indexOf('/** The console home'))).toMatch(
      /to="\/settings"[\s\S]{0,400}Back to app/,
    );
    // …and a sub-view repeats both at the end of a long page.
    expect(shell).toMatch(/section !== '' \?[\s\S]{0,600}to="\/console"[\s\S]{0,400}to="\/settings"/);
  });

  it('the wordmark is a link home — the conventional escape hatch', () => {
    expect(src).toMatch(/<Link to="\/console"[\s\S]{0,160}BLACK BOX/);
  });

  it('an unknown or unauthorised section falls back to home, never a blank screen', () => {
    expect(src).toMatch(/me\.nav\.some\(\(n\) => n\.key === requested\) \? requested : ''/);
  });

  it('console home links onward to every section the server allowed', () => {
    const home = src.slice(src.indexOf('function HomeView'), src.indexOf('function ConsoleShell'));
    expect(home).toMatch(/me\.nav[\s\S]{0,120}\.map\(\(n\) => \(/);
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
