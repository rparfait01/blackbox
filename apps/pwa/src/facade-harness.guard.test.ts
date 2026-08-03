import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from '../../../test-utils/guard-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
/** Comment-stripped — behaviour, not prose (test-utils/guard-source.mjs). */
const code = (p: string): string => stripComments(raw(p));
const config = JSON.parse(raw('config/security-headers.json'));

/**
 * Brief 42 §E4 — the harness exists BEFORE the CSP does.
 *
 * "Enforcing a CSP without a way to prove the facade is byte-identical is enforcing blind", and
 * the person who discovers a broken Hidden facade is a survivor in the middle of needing it. These
 * assert the harness is real and the policy is derived from the bundle rather than from a template.
 */
describe('§A the policy is strict, and derived from what the bundle actually needs', () => {
  it('no unsafe-inline and no unsafe-eval, anywhere', () => {
    for (const [directive, values] of Object.entries(config.csp)) {
      if (!Array.isArray(values)) continue;
      expect(values, `${directive} must not permit unsafe-inline`).not.toContain("'unsafe-inline'");
      expect(values, `${directive} must not permit unsafe-eval`).not.toContain("'unsafe-eval'");
    }
  });

  it('frame-ancestors denies embedding', () => {
    expect(config.csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('font-src permits data: — the build inlines font subsets (found by the browser pass)', () => {
    // Six @font-face rules inline their smallest subsets as data:font/woff2. Under font-src
    // 'self' they are blocked and the facade's typography changes, which in Hidden mode is a
    // covert-mode failure. The first static audit missed this because it read only .js.
    expect(config.csp['font-src']).toContain('data:');
  });

  it('the audit reads CSS, not just JS — that gap is how the data: fonts were missed', () => {
    const audit = code('scripts/facade-audit.mjs');
    expect(audit).toMatch(/endsWith\('\.css'\)/);
    expect(audit).toMatch(/cssDataFonts/);
  });

  it('capture survives the policy: blob: for media, self for the service worker', () => {
    // These two are the difference between a CSP and a covert-mode outage. blob: is how a
    // recording plays back; worker-src is whether offline capture registers at all (§E1).
    expect(config.csp['media-src']).toContain('blob:');
    expect(config.csp['worker-src']).toContain("'self'");
  });

  it('connect-src names the API origin and nothing wider', () => {
    const connect = config.csp['connect-src'];
    expect(connect).toContain("'self'");
    expect(connect.some((v: string) => v.includes('blackbox-api'))).toBe(true);
    expect(connect, 'a wildcard here would defeat the directive').not.toContain('*');
    expect(connect.every((v: string) => v === "'self'" || v.startsWith('https://'))).toBe(true);
  });

  it('object-src is none and base-uri is self', () => {
    expect(config.csp['object-src']).toEqual(["'none'"]);
    expect(config.csp['base-uri']).toEqual(["'self'"]);
  });
});

describe('§B transport and framing are stated, with their reasoning', () => {
  it('HSTS states a max-age and does NOT request preload (§E3)', () => {
    const hsts = config.headers['Strict-Transport-Security'];
    expect(hsts).toMatch(/max-age=\d+/);
    // Preload is removed on the browser vendor's timetable, not ours, and this domain is under
    // active development. Hard to reverse means do not do it yet.
    expect(hsts).not.toMatch(/preload/);
  });

  it('the referrer policy leaks no path — the coordinator token lives in a URL (§D)', () => {
    expect(config.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('permissions policy grants only microphone, camera and geolocation', () => {
    const pp = config.headers['Permissions-Policy'];
    for (const granted of ['microphone=(self)', 'camera=(self)', 'geolocation=(self)']) {
      expect(pp).toContain(granted);
    }
    // Everything else is denied explicitly rather than left to a default that may change.
    for (const denied of ['payment=()', 'usb=()', 'display-capture=()']) {
      expect(pp).toContain(denied);
    }
  });

  it('nosniff is set', () => {
    expect(config.headers['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('§E4 the harness can actually fail', () => {
  const audit = code('scripts/facade-audit.mjs');

  it('it checks the requirements that would break capture', () => {
    expect(audit).toMatch(/OFFLINE CAPTURE BREAKS/);
    expect(audit).toMatch(/recordings would not play back/);
  });

  it('an unclassified origin is a failure, not a note', () => {
    // A mention nobody has looked at is the interesting case: either a new dependency started
    // talking to something, or someone added a fetch.
    expect(audit).toMatch(/unclassified origin\(s\) in the bundle/);
    const problemsPush = audit.slice(audit.indexOf('unclassified.length'));
    expect(problemsPush.slice(0, 200)).toMatch(/problems\.push/);
  });

  it('the diff compares the shell AND every asset hash, and exits non-zero', () => {
    expect(audit).toMatch(/index\.html differs/);
    expect(audit).toMatch(/BYTE-IDENTICAL/);
    expect(audit).toMatch(/process\.exit\(1\)/);
  });

  it('every classified origin carries a reason, not just a name', () => {
    const classified = config._originsMentionedButNeverFetched;
    for (const [origin, reason] of Object.entries(classified)) {
      if (origin.startsWith('_')) continue;
      expect(typeof reason, `${origin} needs a stated reason`).toBe('string');
      expect((reason as string).length, `${origin}'s reason is too thin to review`).toBeGreaterThan(15);
    }
  });
});
