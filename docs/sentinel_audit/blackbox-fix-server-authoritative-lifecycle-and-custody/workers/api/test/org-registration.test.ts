import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_REDEMPTION_ATTEMPTS,
  registrationCodeRedeemable,
} from '../src/lib/org-registration';

/**
 * Brief 24 — org registration guards. The registration code is single-use, admin-only,
 * bound to a pre-created org, consumed ONLY on an explicit POST (never a passive GET),
 * and structurally distinct from enrollment codes.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, '..', p), 'utf8');

const valid = { revoked: 0, expiresAt: 2000, redeemedAt: null, attemptCount: 0 };
const now = 1000;

describe('§2 registration-code redeemability (pure) — every rejection path', () => {
  it('a fresh, unexpired, unredeemed code is redeemable', () => {
    expect(registrationCodeRedeemable(valid, now)).toEqual({ ok: true });
  });
  it('missing → not_found', () => {
    expect(registrationCodeRedeemable(null, now)).toEqual({ ok: false, reason: 'not_found' });
  });
  it('revoked → refused', () => {
    expect(registrationCodeRedeemable({ ...valid, revoked: 1 }, now)).toEqual({ ok: false, reason: 'revoked' });
  });
  it('already redeemed → refused (single-use, permanently)', () => {
    expect(registrationCodeRedeemable({ ...valid, redeemedAt: 500 }, now)).toEqual({ ok: false, reason: 'redeemed' });
  });
  it('too many attempts → locked (rate limit)', () => {
    expect(registrationCodeRedeemable({ ...valid, attemptCount: MAX_REDEMPTION_ATTEMPTS }, now)).toEqual({
      ok: false,
      reason: 'locked',
    });
  });
  it('expired (expiry at/before now) → refused', () => {
    expect(registrationCodeRedeemable({ ...valid, expiresAt: now }, now)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('§3 the GET path is passive — it consumes nothing and mutates nothing', () => {
  const lib = read('src/lib/org-registration.ts');
  const route = read('src/routes/org-register.ts');

  it('getRegistrationOrgView performs only SELECTs — no UPDATE/INSERT/DELETE', () => {
    const fn = lib.slice(lib.indexOf('export async function getRegistrationOrgView'), lib.indexOf('export type CompleteFailure'));
    expect(fn).not.toMatch(/UPDATE |INSERT |DELETE /);
  });
  it('the GET route calls only the read-only view (no completion/consume on GET)', () => {
    const get = route.slice(route.indexOf("orgRegisterRoutes.get"), route.indexOf('orgRegisterRoutes.post'));
    expect(get).toMatch(/getRegistrationOrgView/);
    expect(get).not.toMatch(/completeAdminRegistration/);
  });
  it('the code is consumed ONLY in the completion POST, and that POST requires a session', () => {
    expect(route).toMatch(/orgRegisterRoutes\.post\('\/complete', requireSession/);
    // completeAdminRegistration (the only consumer) is invoked from the POST, not GET.
    expect(route.slice(route.indexOf("post('/complete'"))).toMatch(/completeAdminRegistration/);
  });
});

describe('§2 code-type separation is structural (both directions)', () => {
  const orgRoutes = read('src/routes/org.ts');
  const regLib = read('src/lib/org-registration.ts');

  it('the enrollment /codes endpoint can never mint an admin code', () => {
    // Only coordinator|survivor are enrollable; admin is not a reachable branch.
    expect(orgRoutes).toMatch(/body\.role === 'coordinator' \? 'coordinator' : 'survivor'/);
    const codes = orgRoutes.slice(orgRoutes.indexOf("post('/codes'"), orgRoutes.indexOf("post('/admins/invite'"));
    expect(codes).not.toMatch(/role: 'admin'|role === 'admin'/);
  });
  it('registration codes live in their own table, never enrollment_codes', () => {
    expect(regLib).toMatch(/FROM admin_registration_codes/);
    expect(regLib).not.toMatch(/INSERT INTO enrollment_codes|FROM enrollment_codes/);
  });
  it('completing registration binds the admin role only', () => {
    expect(regLib).toMatch(/bindAccountToOrg\(env, \{ userId: input\.userId, orgId: [^,]+, role: 'admin' \}\)/);
  });
});

describe('§0/§5/§6 min-two-admins + seat lock', () => {
  const org = read('src/lib/org.ts');
  const enrollment = read('src/lib/enrollment.ts');

  it('MIN_ADMINS is 2 and seat issuance is locked below it', () => {
    expect(org).toMatch(/MIN_ADMINS = 2/);
    expect(org).toMatch(/countActiveAdmins\(env, orgId\)\) < MIN_ADMINS/);
  });
  it('survivor bind refuses needs_two_admins while seat issuance is locked', () => {
    expect(enrollment).toMatch(/seatIssuanceLocked\(env, orgId\)/);
    expect(enrollment).toMatch(/needs_two_admins/);
  });
  it('removing the second-to-last admin is blocked', () => {
    expect(org).toMatch(/admins >= MIN_ADMINS && admins - 1 < MIN_ADMINS/);
    expect(enrollment).toMatch(/adminRemovalBlocked\(env, orgId\)/);
    expect(enrollment).toMatch(/reason: 'min_admins'/);
  });
});
