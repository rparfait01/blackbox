import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Accounts §1/§2 tripwire — passwordless, and no email-reset.
 *
 * The two failures pinned here are both about the same person: a survivor whose
 * abuser shares their home and may know their passwords, watch them type, find
 * what they wrote down, and read their email.
 *
 *  1. A PASSWORD reappearing anywhere. Every password is a thing that can be
 *     found, guessed, watched, or coerced out of someone. The product's answer is
 *     to not have one.
 *  2. An EMAIL-based way into an account that HAS a passkey. §2 bans
 *     password-reset-by-email because the inbox may be monitored; an emailed login
 *     link hands over exactly the same thing, so the ban has to cover it. The
 *     magic link survives only as the fallback for accounts with no passkey.
 *
 * These read the source so a regression fails here rather than in front of a
 * survivor.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Every .ts/.tsx under src, excluding the guard tests themselves. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('§1 no password exists anywhere in the app', () => {
  it('no source file renders a password input', () => {
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      const where = relative(SRC, file);
      expect(src, `${where} renders a password field`).not.toMatch(/type=["']password["']/);
      expect(src, `${where} autocompletes a password`).not.toMatch(/autoComplete=["'](current|new)-password["']/);
    }
  });

  it('no source file posts a password to the API', () => {
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      const where = relative(SRC, file);
      // The closure PIN is a different thing entirely (a closure secret, not a
      // login credential) and is deliberately not matched here.
      expect(src, `${where} sends a password`).not.toMatch(/body:\s*\{[^}]*\bpassword\b/);
    }
  });

  // NOTE: these assert MECHANISM, not the word "password" — the copy legitimately
  // says "No password" to the user, and a guard that banned the word would fail on
  // its own explanation.
  it('the signin screen offers passkey, email link, and recovery — and no signin-by-password', () => {
    const signin = read('./routes/signin/SignIn.tsx');
    expect(signin).toContain('loginWithPasskey');
    expect(signin).toContain('/v1/auth/magic/start');
    expect(signin).toContain('/v1/auth/recovery/consume');
    // The password endpoint is retained server-side for the pilot's migration, but
    // NOTHING in the UI may reach it.
    expect(signin).not.toContain('/v1/auth/signin');
    expect(signin).not.toMatch(/const \[password/);
  });

  it('onboarding creates the account without a password and enrolls a passkey', () => {
    const onboarding = read('./routes/onboarding/Onboarding.tsx');
    expect(onboarding).not.toMatch(/const \[password/);
    expect(onboarding).toContain('enrollPasskey');
    expect(onboarding).toContain('/v1/auth/recovery/issue');
  });
});

describe('§2 there is NO password-reset-by-email path', () => {
  it('the reset flow and its routes are gone', () => {
    const router = read('./app/router.tsx');
    expect(router).not.toContain('ResetFlow');
    expect(router).not.toMatch(/path:\s*['"]\/forgot['"]/);
    expect(router).not.toMatch(/path:\s*['"]\/reset['"]/);
  });

  it('no source file calls a reset endpoint', () => {
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${relative(SRC, file)} calls a reset endpoint`).not.toMatch(/\/v1\/auth\/(forgot|reset)/);
    }
  });

  it('the magic-link landing sets no password — it exchanges a token for a session', () => {
    const magic = read('./routes/signin/MagicLink.tsx');
    expect(magic).toContain('/v1/auth/magic/consume');
    expect(magic).not.toMatch(/const \[password/);
    // It offers the passkey — the step that stops the account being email-reachable.
    expect(magic).toContain('enrollPasskey');
  });
});

describe('§1 nothing dead-ends', () => {
  it('a device without passkey support is offered the email link, not an error', () => {
    const signin = read('./routes/signin/SignIn.tsx');
    expect(signin).toContain('passkeySupported()');
    // The fallback pane must be reachable when unsupported.
    expect(signin).toMatch(/setPane\('email-link'\)/);
  });

  it('a cancelled ceremony is not reported as a failure', () => {
    const passkey = read('./lib/passkey.ts');
    expect(passkey).toContain("'cancelled'");
    expect(passkey).toContain('NotAllowedError');
  });
});

describe('§0a the Hidden facade carries no account UI', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface shows sign-in, passkey, or recovery affordances', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not surface auth`).not.toMatch(/passkey|recovery code|sign in|magic/i);
      expect(src, `${f} must not call auth endpoints`).not.toMatch(/\/v1\/auth\//);
    }
  });
});
