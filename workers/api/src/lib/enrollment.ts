/**
 * Enrollment (Brief 23 §3 — Distribution). An enrollment code binds one account to
 * one org + role. Codes are unguessable, expirable, revocable, and usage-bounded; a
 * leaked code grants MEMBERSHIP ONLY, never read access to any survivor's data
 * (isolation is enforced separately in requireOrgRole + orgId-scoped reads).
 *
 * Two role classes bind differently:
 *   - survivor            → sets users.orgId AND consumes a license seat (atomic
 *                           ceiling). This is also the individual→org migration path:
 *                           explicit, consented, history preserved, reversible.
 *   - coordinator | admin → sets users.orgId AND creates an active org_members (STAFF)
 *                           row. Staff do NOT consume a survivor seat.
 */
import { audit } from './audit';
import { grantEntitlement } from './entitlement';
import { adminRemovalBlocked, getActiveLicense, seatIssuanceLocked } from './org';
import type { Env, EnrollmentCodeRow } from '../types';

export type RedeemFailure = 'not_found' | 'revoked' | 'expired' | 'exhausted';
export type BindFailure = 'already_in_org' | 'seats_full' | 'no_license' | 'needs_two_admins';

/**
 * Pure redeemability rule for a code at a given instant. Decoupled from D1 so every
 * rejection path is unit-testable. Does NOT consume the code — that is an atomic DB
 * step in redeemCode.
 */
export function codeRedeemable(
  row: Pick<EnrollmentCodeRow, 'revoked' | 'expiresAt' | 'maxUses' | 'usedCount'> | null,
  now: number,
): { ok: true } | { ok: false; reason: RedeemFailure } {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (row.expiresAt != null && row.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (row.usedCount >= row.maxUses) return { ok: false, reason: 'exhausted' };
  return { ok: true };
}

/** Load a code row verbatim. */
async function loadCode(env: Env, code: string): Promise<EnrollmentCodeRow | null> {
  return env.DB.prepare(
    'SELECT code, orgId, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt FROM enrollment_codes WHERE code = ?',
  )
    .bind(code)
    .first<EnrollmentCodeRow>();
}

/**
 * Bind an account to an org in the given role. Server-authoritative, atomic where a
 * race matters. Refuses if the account is already in a DIFFERENT org (leave first).
 * Survivor role reserves a seat with an atomic conditional UPDATE (no read-then-write
 * race on the ceiling); staff create/reactivate an org_members row.
 */
export async function bindAccountToOrg(
  env: Env,
  input: { userId: string; orgId: string; role: 'survivor' | 'coordinator' | 'admin' },
): Promise<{ ok: true } | { ok: false; reason: BindFailure }> {
  const { userId, orgId, role } = input;
  const user = await env.DB.prepare('SELECT orgId FROM users WHERE id = ?')
    .bind(userId)
    .first<{ orgId: string | null }>();
  if (user?.orgId && user.orgId !== orgId) {
    return { ok: false, reason: 'already_in_org' };
  }

  if (role === 'survivor') {
    // Brief 24 §5 — seat issuance is locked until the org has two admins. No survivor
    // is enrolled into an org not yet staffed with two accountable admins. (Skip the
    // check for an idempotent re-bind of a seat this account already holds.)
    if (user?.orgId !== orgId && (await seatIssuanceLocked(env, orgId))) {
      return { ok: false, reason: 'needs_two_admins' };
    }
    // Atomic seat reservation: only succeeds while seats remain under the ceiling.
    const license = await getActiveLicense(env, orgId);
    if (!license) return { ok: false, reason: 'no_license' };
    // Skip the increment if this account already holds this org's seat (idempotent
    // re-redeem) — otherwise reserve one atomically.
    if (user?.orgId !== orgId) {
      const reserved = await env.DB.prepare(
        "UPDATE org_licenses SET seatsUsed = seatsUsed + 1 WHERE orgId = ? AND status = 'active' AND seatsUsed < seatsTotal",
      )
        .bind(orgId)
        .run();
      if (reserved.meta.changes !== 1) return { ok: false, reason: 'seats_full' };
    }
    await env.DB.prepare('UPDATE users SET orgId = ?, updatedAt = ? WHERE id = ?')
      .bind(orgId, Date.now(), userId)
      .run();
  } else {
    // Staff: set org membership, no survivor seat consumed.
    await env.DB.prepare('UPDATE users SET orgId = ?, updatedAt = ? WHERE id = ?')
      .bind(orgId, Date.now(), userId)
      .run();
    const existing = await env.DB.prepare(
      'SELECT id FROM org_members WHERE orgId = ? AND userId = ?',
    )
      .bind(orgId, userId)
      .first<{ id: string }>();
    if (existing) {
      await env.DB.prepare("UPDATE org_members SET role = ?, status = 'active' WHERE id = ?")
        .bind(role, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO org_members (id, orgId, userId, role, status, createdAt) VALUES (?, ?, ?, ?, 'active', ?)",
      )
        .bind(crypto.randomUUID(), orgId, userId, role, Date.now())
        .run();
    }
  }
  // Brief 28 §2 — org enrollment activates entitlement (source org_code). Idempotent
  // and never-downgrading: if this account was already activated (e.g. an earlier web
  // purchase, or a prior re-redeem) its original source is preserved. The §0 promise
  // holds here — this grant is permanent, so if the org's license later lapses the
  // survivor stays armed; leaving the org (leaveOrg) frees the seat but likewise never
  // reaches in to re-lock the survivor.
  await grantEntitlement(env, userId, 'org_code');
  await audit(env, null, 'org.enroll', userId, { orgId, role });
  return { ok: true };
}

/**
 * Redeem a code for an account: validate, atomically consume one use, then bind. The
 * atomic `usedCount` increment is the race barrier — if two redemptions land at once
 * only one consumes the last use.
 */
export async function redeemCode(
  env: Env,
  code: string,
  userId: string,
): Promise<
  | { ok: true; orgId: string; role: 'survivor' | 'coordinator' | 'admin' }
  | { ok: false; reason: RedeemFailure | BindFailure }
> {
  const now = Date.now();
  const row = await loadCode(env, code);
  const verdict = codeRedeemable(row, now);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // Consume one use atomically — re-checks every condition so a concurrent redeem
  // can't push usedCount past maxUses.
  const consumed = await env.DB.prepare(
    'UPDATE enrollment_codes SET usedCount = usedCount + 1 WHERE code = ? AND revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR expiresAt > ?)',
  )
    .bind(code, now)
    .run();
  if (consumed.meta.changes !== 1) return { ok: false, reason: 'exhausted' };

  const bind = await bindAccountToOrg(env, { userId, orgId: row!.orgId, role: row!.role });
  if (!bind.ok) {
    // Give the use back — the bind was refused (seats full / already in another org),
    // so this redemption did not actually enroll anyone.
    await env.DB.prepare('UPDATE enrollment_codes SET usedCount = usedCount - 1 WHERE code = ?')
      .bind(code)
      .run();
    return { ok: false, reason: bind.reason };
  }
  return { ok: true, orgId: row!.orgId, role: row!.role };
}

/**
 * Leave an org (reversal per policy). Unsets users.orgId, revokes any staff
 * membership, and frees the survivor's seat (only survivors consume one). Past events
 * keep their stamped orgId — custody attribution is immutable, history preserved.
 *
 * Brief 24: refuses to remove the second-to-last admin (the org must keep MIN_ADMINS).
 */
export async function leaveOrg(
  env: Env,
  userId: string,
): Promise<{ ok: true; left: boolean } | { ok: false; reason: 'min_admins' }> {
  const user = await env.DB.prepare('SELECT orgId FROM users WHERE id = ?')
    .bind(userId)
    .first<{ orgId: string | null }>();
  if (!user?.orgId) return { ok: true, left: false };
  const orgId = user.orgId;
  const staff = await env.DB.prepare(
    "SELECT id, role FROM org_members WHERE orgId = ? AND userId = ? AND status = 'active'",
  )
    .bind(orgId, userId)
    .first<{ id: string; role: string }>();
  if (staff) {
    // Min-2-admin guard: an org may not drop below two admins by removing one (§0/§6).
    if (staff.role === 'admin' && (await adminRemovalBlocked(env, orgId))) {
      return { ok: false, reason: 'min_admins' };
    }
    await env.DB.prepare("UPDATE org_members SET status = 'revoked' WHERE orgId = ? AND userId = ?")
      .bind(orgId, userId)
      .run();
  } else {
    // A survivor freed their seat. Floor at 0 so a double-leave can't go negative.
    await env.DB.prepare(
      "UPDATE org_licenses SET seatsUsed = MAX(0, seatsUsed - 1) WHERE orgId = ? AND status = 'active'",
    )
      .bind(orgId)
      .run();
  }
  await env.DB.prepare('UPDATE users SET orgId = NULL, updatedAt = ? WHERE id = ?')
    .bind(Date.now(), userId)
    .run();
  await audit(env, null, 'org.leave', userId, { orgId });
  return { ok: true, left: true };
}
