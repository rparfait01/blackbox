import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY RULE: no unintentional sign-out, ever.
 *
 * A session ends when the person ends it, and at no other time. The failure this prevents
 * is specific and severe: a survivor opens the app to trigger an alert and is shown a
 * login form instead, because a timer expired or a request failed while they had no
 * signal. Losing the network is not losing the session.
 *
 * These pin the rule structurally, because it is the kind of rule that decays one
 * reasonable-looking error handler at a time.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Every .ts/.tsx under src, excluding tests. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe('rule 4 — only an explicit sign-out clears the session', () => {
  it('every clearSession() call sits in a sign-out or delete-account handler', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // The definition itself, and imports, are not calls.
      const body = src.replace(/export function clearSession[\s\S]*?\n\}/, '');
      const lines = body.split('\n');
      lines.forEach((line, i) => {
        if (!/\bclearSession\(\)/.test(line)) return;
        // Look back for the enclosing function name.
        const context = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
        const ok = /function signOut|const signOut|async function deleteAccount|function deleteAccount|confirmDelete/.test(context);
        if (!ok) offenders.push(`${relative(SRC, file)}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(offenders, `clearSession() called outside an explicit sign-out:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no error handler, catch block, or failed-request path clears the session', () => {
    for (const file of sources()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // A clearSession within a catch{} or an !ok / status-check branch is exactly the
      // "signed out because the network blipped" bug this rule exists to prevent.
      expect(src, `${relative(SRC, file)} clears the session in a catch block`).not.toMatch(
        /catch\s*(\([^)]*\))?\s*\{[^}]{0,200}clearSession\(\)/,
      );
      expect(src, `${relative(SRC, file)} clears the session on a failed request`).not.toMatch(
        /(!res\.ok|status === 401|status === 0)[^}]{0,200}clearSession\(\)/,
      );
    }
  });
});

describe('rule 2 — the app decides "signed in" from the device, never the network', () => {
  it('RootGate reads storage synchronously and makes no request', () => {
    const gate = stripComments(read('./app/RootGate.tsx'));
    expect(gate).toMatch(/getSessionToken\(\) == null/);
    // An await/fetch here would mean a reopen with no signal could not resolve.
    expect(gate).not.toMatch(/await|fetch\(|api</);
  });

  it('the armed screen and activation gate on stored setup, not on a server check', () => {
    for (const f of ['./routes/blackbox/BlackBoxHome.tsx', './routes/blackbox/Activation.tsx']) {
      const src = stripComments(read(f));
      expect(src, `${f} must gate on local setup state`).toMatch(/isSetupComplete\(\)/);
    }
  });
});

describe('rule 5 — a failed server check degrades, it never signs anyone out', () => {
  const console_ = stripComments(read('./routes/console/Console.tsx'));

  it('retries before giving up, and only a CONFIRMED answer changes access state', () => {
    expect(console_).toMatch(/attempt < 3[\s\S]{0,200}checkLevel\(attempt \+ 1\)/);
    // 'no-access' is reachable only when the server actually answered (res.ok).
    expect(console_).toMatch(/if \(res\.ok\) \{[\s\S]{0,160}setPhase\('no-access'\)/);
  });

  it('an unreachable server yields a degraded state, never a sign-in prompt', () => {
    expect(console_).toMatch(/setPhase\('unreachable'\)/);
    // The old bug, in one line: a 401 or a network blip choosing the sign-in pane.
    expect(console_).not.toMatch(/res\.status === 401 \? 'signin'/);
  });

  it('the unreachable screen states the session is intact and offers no sign-in', () => {
    const view = console_.slice(console_.indexOf("phase === 'unreachable'"), console_.indexOf("phase === 'no-access'"));
    expect(view).toMatch(/still signed in/i);
    expect(view).toMatch(/Try again/);
    expect(view).not.toMatch(/signOut|setPane\('email-link'\)|Sign in/);
  });
});

describe('rule 1 + 3 — the session token carries no deadline', () => {
  const session = readFileSync(join(SRC, '../../../workers/api/src/lib/session.ts'), 'utf8');
  const code = stripComments(session);

  it('verifySession compares a signature and nothing else — no age check', () => {
    expect(code).toMatch(/constantTimeEqual\(expected, sig\)/);
    // Any clock arithmetic on issuedAt would be an expiry by another name.
    expect(code).not.toMatch(/Date\.now\(\)\s*-\s*issuedAt|issuedAt\s*[<>]=?\s*(Date\.now|now|cutoff|expiry)/);
    expect(code).not.toMatch(/maxAge|max_age|expiresIn|ttl|TTL/i);
  });

  it('mintSession sets no expiry field', () => {
    expect(code).toMatch(/\$\{userId\}\.\$\{issuedAt\}\.\$\{sig\}/);
    expect(code).not.toMatch(/exp\b|expiresAt/);
  });

  it('the no-expiry rule is documented as permanent, not as a "v0" placeholder', () => {
    expect(session).toMatch(/NOT EVER|not ever/);
  });

  it('the accepted trade-off is recorded where the rule lives', () => {
    // A rule with a real cost must carry that cost in writing, or the next person to read
    // it "fixes" the missing expiry without knowing what was weighed.
    expect(session).toMatch(/TRADE THIS MAKES|ACCEPTED DELIBERATELY/);
    expect(session).toMatch(/found or unlocked device/i);
    expect(session).toMatch(/covert facade/i);
  });

  it('any future expiring token must ship silent refresh in the same change', () => {
    expect(session).toMatch(/SILENT BACKGROUND REFRESH/);
  });
});
