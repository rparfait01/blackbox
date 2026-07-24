/**
 * Org registration (Brief 24) — the vetted, invite-only front door. A single-use,
 * admin-only code claims the FIRST admin seat on a PRE-CREATED org. The org already
 * exists before the code is issued, so a stolen code cannot register "Fake Shelter
 * Inc." — it can only confirm admin #1 on the specific org it is bound to, and it can
 * never confer a coordinator seat or a second admin.
 *
 * This module is distinct from lib/enrollment.ts on purpose (§2): registration codes
 * live in their own table and are consumed by a DIFFERENT ceremony (creating the first
 * admin account), never the survivor/coordinator enrollment path.
 */
import { audit } from './audit';
import { bindAccountToOrg } from './enrollment';
import { getOrg } from './org';
import { generateReadableCode, normalizeCode } from './readable-code';
import type { AdminRegistrationCodeRow, Env } from '../types';

/** Default registration-code lifetime — short; a registration code is never standing. */
export const DEFAULT_TTL_DAYS = 14;

/** Redemption attempts allowed against one code before it locks (server-side rate
 *  limit, §2). A 128-bit code is already unguessable; this caps abuse of a leaked one
 *  and forces an operator re-issue rather than letting it be hammered. */
export const MAX_REDEMPTION_ATTEMPTS = 10;

export type RegRedeemFailure = 'not_found' | 'revoked' | 'expired' | 'redeemed' | 'locked';

/**
 * Pure redeemability rule for a registration code at an instant — decoupled from D1 so
 * every rejection path is unit-testable. Does NOT consume; consumption is an atomic DB
 * step in completeAdminRegistration.
 */
export function registrationCodeRedeemable(
  row: Pick<AdminRegistrationCodeRow, 'revoked' | 'expiresAt' | 'redeemedAt' | 'attemptCount'> | null,
  now: number,
): { ok: true } | { ok: false; reason: RegRedeemFailure } {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (row.redeemedAt != null) return { ok: false, reason: 'redeemed' };
  if (row.attemptCount >= MAX_REDEMPTION_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

async function loadCode(env: Env, code: string): Promise<AdminRegistrationCodeRow | null> {
  const cols =
    'SELECT code, orgId, expiresAt, revoked, redeemedAt, redeemedByUserId, attemptCount, lastAttemptAt, reissueReason, createdBy, createdAt FROM admin_registration_codes WHERE code = ?';
  // Exact match first (legacy hex codes) then normalized (new readable codes — Brief 28 §4).
  const exact = await env.DB.prepare(cols).bind(code).first<AdminRegistrationCodeRow>();
  if (exact) return exact;
  const normalized = normalizeCode(code);
  if (normalized === code) return null;
  return env.DB.prepare(cols).bind(normalized).first<AdminRegistrationCodeRow>();
}

/** Mint a single-use admin registration code bound to a pre-created org. */
export async function createAdminRegistrationCode(
  env: Env,
  input: { orgId: string; createdBy?: string | null; ttlDays?: number; reissueReason?: string | null },
): Promise<AdminRegistrationCodeRow> {
  const now = Date.now();
  const row: AdminRegistrationCodeRow = {
    // Brief 28 §4 — readable Crockford code, stored normalized, delivered separately
    // from the link. Redeemed after normalization; legacy hex codes still exact-match.
    code: generateReadableCode(10),
    orgId: input.orgId,
    expiresAt: now + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000,
    revoked: 0,
    redeemedAt: null,
    redeemedByUserId: null,
    attemptCount: 0,
    lastAttemptAt: null,
    reissueReason: input.reissueReason ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
  };
  await env.DB.prepare(
    'INSERT INTO admin_registration_codes (code, orgId, expiresAt, revoked, redeemedAt, redeemedByUserId, attemptCount, lastAttemptAt, reissueReason, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.code, row.orgId, row.expiresAt, 0, null, null, 0, null, row.reissueReason, row.createdBy, row.createdAt)
    .run();
  return row;
}

export interface RegistrationOrgView {
  orgId: string;
  name: string;
  lane: 'zero_fee' | 'paid';
  seatsTotal: number;
  termStart: number | null;
  termEnd: number | null;
  /** True once admin #1 has accepted the license — an admin #2+ invite skips the
   *  license click-through (it was accepted for the org already). */
  licenseAlreadyAccepted: boolean;
}

/**
 * READ-ONLY org details for the registration page — the §3 passive-GET-safe path. This
 * NEVER consumes the code, increments an attempt, or mutates any state. A scanner
 * hitting the GET that calls this changes nothing. Returns null for an unusable code
 * (consumed / revoked / expired / locked) so a spent code reads as a dead route and the
 * page shows an honest "invalid or expired" without revealing which. A still-valid code
 * works even if the org already has admin #1 — that is an admin #2 invite.
 */
export async function getRegistrationOrgView(env: Env, code: string): Promise<RegistrationOrgView | null> {
  const row = await loadCode(env, code);
  if (!registrationCodeRedeemable(row, Date.now()).ok) return null;
  const org = await getOrg(env, row!.orgId);
  if (!org) return null;
  const license = await env.DB.prepare(
    "SELECT seatsTotal, termStart, termEnd FROM org_licenses WHERE orgId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
  )
    .bind(row!.orgId)
    .first<{ seatsTotal: number; termStart: number | null; termEnd: number | null }>();
  return {
    orgId: org.id,
    name: org.name,
    lane: org.lane,
    seatsTotal: license?.seatsTotal ?? 0,
    termStart: license?.termStart ?? null,
    termEnd: license?.termEnd ?? null,
    licenseAlreadyAccepted: org.licenseAcceptedAt != null,
  };
}

export type CompleteFailure = RegRedeemFailure | 'bind_failed';

/**
 * Complete admin registration — the ONLY place a registration code is consumed, and
 * only from the explicit completion POST (never a GET). Atomic consume is the race
 * barrier: the UPDATE both records the attempt and claims the code in one conditional
 * write, so a concurrent replay finds it already redeemed. On success: bind admin #1,
 * record the license acceptance, audit.
 */
export async function completeAdminRegistration(
  env: Env,
  input: { userId: string; code: string; licenseVersion: string; acceptancePath: 'click_through' | 'out_of_band' },
): Promise<{ ok: true; orgId: string } | { ok: false; reason: CompleteFailure }> {
  const now = Date.now();
  const row = await loadCode(env, input.code);
  // Use the RESOLVED stored code for every write — the user's raw input may differ in
  // case/dashes from the normalized stored form (Brief 28 §4).
  const storedCode = row?.code ?? input.code;
  // Always record the attempt (rate-limit signal), even on a doomed try.
  if (row) {
    await env.DB.prepare(
      'UPDATE admin_registration_codes SET attemptCount = attemptCount + 1, lastAttemptAt = ? WHERE code = ?',
    )
      .bind(now, storedCode)
      .run();
  }
  const verdict = registrationCodeRedeemable(row, now);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // Atomically claim the code: only the first completion flips redeemedAt from NULL.
  const claimed = await env.DB.prepare(
    'UPDATE admin_registration_codes SET redeemedAt = ?, redeemedByUserId = ? WHERE code = ? AND redeemedAt IS NULL AND revoked = 0',
  )
    .bind(now, input.userId, storedCode)
    .run();
  if (claimed.meta.changes !== 1) return { ok: false, reason: 'redeemed' };

  const bind = await bindAccountToOrg(env, { userId: input.userId, orgId: row!.orgId, role: 'admin' });
  if (!bind.ok) {
    // Give the code back — the admin bind failed, so no one registered.
    await env.DB.prepare('UPDATE admin_registration_codes SET redeemedAt = NULL, redeemedByUserId = NULL WHERE code = ?')
      .bind(storedCode)
      .run();
    return { ok: false, reason: 'bind_failed' };
  }
  // Record the license acceptance on the org (§4) — ONCE, for admin #1. An admin #2+
  // invite does not overwrite who first accepted (the audit log records each admin).
  await env.DB.prepare(
    'UPDATE organizations SET licenseAcceptedBy = ?, licenseAcceptedAt = ?, licenseVersion = ?, licenseAcceptancePath = ? WHERE id = ? AND licenseAcceptedAt IS NULL',
  )
    .bind(input.userId, now, input.licenseVersion, input.acceptancePath, row!.orgId)
    .run();
  await audit(env, null, 'org.admin_registered', input.userId, {
    orgId: row!.orgId,
    licenseVersion: input.licenseVersion,
    acceptancePath: input.acceptancePath,
  });
  return { ok: true, orgId: row!.orgId };
}

/** Operator: revoke a live registration code (before redemption), logged with reason. */
export async function revokeRegistrationCode(
  env: Env,
  code: string,
  reason: string,
  by: string | null,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE admin_registration_codes SET revoked = 1 WHERE code = ? AND redeemedAt IS NULL',
  )
    .bind(code)
    .run();
  if (res.meta.changes !== 1) return false;
  await audit(env, null, 'org.registration_code_revoke', by, { code, reason });
  return true;
}

/**
 * Operator escape hatch (§6): revoke every live code for an org and issue a fresh one,
 * logged with reason. Recovers an expired code, a wrong recipient, or an admin #1 who
 * left before adding admin #2. The old code stays dead.
 */
export async function reissueRegistrationCode(
  env: Env,
  orgId: string,
  reason: string,
  by: string | null,
): Promise<AdminRegistrationCodeRow> {
  await env.DB.prepare(
    'UPDATE admin_registration_codes SET revoked = 1 WHERE orgId = ? AND redeemedAt IS NULL AND revoked = 0',
  )
    .bind(orgId)
    .run();
  const fresh = await createAdminRegistrationCode(env, { orgId, createdBy: by, reissueReason: reason });
  await audit(env, null, 'org.registration_code_reissue', by, { orgId, reason, code: fresh.code });
  return fresh;
}
