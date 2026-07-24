import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 24 guards — the org registration page. §3 passive-GET hazard: the code is never
 * pre-filled from the URL and is consumed only on an explicit submit. §0a/§4: no
 * survivor-facing UI, no covert facade, no trigger anywhere in this surface.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const reg = read('./routes/org/OrgRegister.tsx');
// Strip comments so a disclaimer ("no covert facade") doesn't false-trip the checks.
const regCode = reg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('§3 the code is entered manually, never taken from the URL', () => {
  it('does not read a code/token from the query string (no useSearchParams / location.search)', () => {
    expect(reg).not.toMatch(/useSearchParams|location\.search|searchParams|params\.get/);
  });
  it('the code comes from a controlled input the user types', () => {
    expect(reg).toMatch(/value=\{code\}/);
    expect(reg).toMatch(/onChange=\{\(e\) => \{ setCode/);
  });
});

describe('§3 consumption happens only on an explicit submit (register), never on load/GET', () => {
  it('the read-only lookup GET does not call the completion endpoint', () => {
    const lookUp = reg.slice(reg.indexOf('async function lookUp'), reg.indexOf('async function register'));
    expect(lookUp).toMatch(/\/v1\/org-register\//);
    expect(lookUp).not.toMatch(/org-register\/complete/);
  });
  it('the completion POST is inside the explicit register() action, gated behind a button', () => {
    expect(reg).toMatch(/'\/v1\/org-register\/complete'/);
    expect(reg).toMatch(/onClick=\{\(\) => void register\(\)\}/);
    // No effect auto-runs register on mount (no passive completion).
    expect(reg).not.toMatch(/useEffect\([\s\S]{0,160}register\(/);
  });
  it('a passkey is enrolled before the completion POST (passkey-then-consume ordering)', () => {
    const body = reg.slice(reg.indexOf('async function register'));
    expect(body.indexOf('enrollPasskey')).toBeGreaterThan(-1);
    expect(body.indexOf('enrollPasskey')).toBeLessThan(body.indexOf('org-register/complete'));
  });
});

describe('§4 org details are read-only; §0a no survivor/covert/trigger UI', () => {
  it('org name/lane/seats are shown in read-only Rows, never in an editable input', () => {
    expect(reg).toMatch(/Row k="Name" v=\{org\.name\}/);
    // No <input> is bound to an org field — the org record cannot be edited here.
    expect(regCode).not.toMatch(/<input[^>]*value=\{org\./);
  });
  it('carries no covert facade / trigger / survivor surface', () => {
    expect(regCode).not.toMatch(/MeditationHome|BreathingCircles|triggerAlert|useDoubleTap/);
  });
});
