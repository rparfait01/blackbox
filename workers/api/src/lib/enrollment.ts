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
import { normalizeCode } from './readable-code';
import type { Env, EnrollmentCodeRow } from '../types';

export type RedeemFailure = 'not_found' | 'revoked' | 'expired' | 'exhausted';
export type BindFailure = 'already_in_org' | 'seats_full' | 'no_license' | 'needs_two_admins';

/** Brief 28 §4 — per-account redemption rate limit (brute-force guard on readable
 *  codes). A short rolling window; a successful redeem ends the attack anyway. */
export const REDEEM_WINDOW_MS = 3_600_000; // 1 hour
export const REDEEM_MAX_ATTEMPTS = 10;

export type RedeemRateVerdict =
  | { allowed: true; windowStart: number; attempts: number }
  | { allowed: false };

/**
 * Pure rate rule for code redemption: given the account's stored window + attempt count
 * and the current time, decide whether another attempt is allowed. A lapsed window
 * resets the count. Decoupled from D1 so every branch is unit-testable.
 */
export function redeemRateDecision(
  stored: { redeemWindowStart: number | null; redeemAttempts: number },
  nowMs: number,
): RedeemRateVerdict {
  const inWindow =
    stored.redeemWindowStart != null && nowMs - stored.redeemWindowStart < REDEEM_WINDOW_MS;
  const used = inWindow ? stored.redeemAttempts : 0;
  if (used >= REDEEM_MAX_ATTEMPTS) return { allowed: false };
  return {
    allowed: true,
    windowStart: inWindow ? stored.redeemWindowStart! : nowMs,
    attempts: used + 1,
  };
}

/**
 * Read the account's redemption counter, decide, and (when allowed) advance it. Returns
 * whether this attempt may proceed. Count every attempt — the guard is against guessing.
 */
export async function checkRedeemRate(
  env: Env,
  userId: string,
  nowMs: number,
): Promise<boolean> {
  const acct = await env.DB.prepare('SELECT redeemWindowStart, redeemAttempts FROM users WHERE id = ?')
    .bind(userId)
    .first<{ redeemWindowStart: number | null; redeemAttempts: number }>();
  const verdict = redeemRateDecision(
    { redeemWindowStart: acct?.redeemWindowStart ?? null, redeemAttempts: acct?.redeemAttempts ?? 0 },
    nowMs,
  );
  if (!verdict.allowed) return false;
  await env.DB.prepare('UPDATE users SET redeemWindowStart = ?, redeemAttempts = ? WHERE id = ?')
    .bind(verdict.windowStart, verdict.attempts, userId)
    .run();
  return true;
}

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

/**
 * Resolve a code row from user input. Tries an EXACT match first (legacy hex codes,
 * issued before Brief 28 §4, are stored verbatim) then a NORMALIZED match (new readable
 * codes are stored normalized, so a survivor may type them lower-case / with dashes).
 * Returns the row with its actual stored `code`, which the caller uses for the atomic
 * consume — never the raw input.
 */
export async function loadCode(env: Env, code: string): Promise<EnrollmentCodeRow | null> {
  const cols =
    'SELECT code, source, orgId, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt FROM enrollment_codes WHERE code = ?';
  const exact = await env.DB.prepare(cols).bind(code).first<EnrollmentCodeRow>();
  if (exact) return exact;
  const normalized = normalizeCode(code);
  if (normalized === code) return null; // no second form to try
  return env.DB.prepare(cols).bind(normalized).first<EnrollmentCodeRow>();
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
 * THE SIGNUP GATE's claim (Brief 30 §C).
 *
 * Claims one use of a code so an account may be created. Deliberately does NOT bind to an
 * org or grant entitlement — the caller sequences those AFTER the account exists, and
 * releases the claim if account creation fails, so a buyer's paid code is never burned by
 * a failed signup.
 *
 * Uses the SAME conditional-UPDATE primitive as org redemption (consumeOneUse), so there
 * is exactly one definition of "already used" in the system. Two requests racing the last
 * use of a code cannot both win: SQLite applies the UPDATEs serially, the first moves
 * usedCount to maxUses, and the second matches zero rows.
 */
export type SignupCodeFailure = 'code_required' | RedeemFailure;

export interface SignupCodeClaim {
  /** The RESOLVED stored code — always use this for follow-up writes, never raw input,
   *  which may differ in case/dashes (Brief 28 §4 normalization). */
  storedCode: string;
  source: 'consumer' | 'institutional';
  orgId: string | null;
  role: 'survivor' | 'coordinator' | 'admin';
}

export async function claimSignupCode(
  env: Env,
  rawCode: string | undefined | null,
  now: number,
): Promise<{ ok: true; claim: SignupCodeClaim } | { ok: false; reason: SignupCodeFailure }> {
  const input = (rawCode ?? '').trim();
  if (!input) {
    return { ok: false, reason: 'code_required' };
  }
  const row = await loadCode(env, input);
  const verdict = codeRedeemable(row, now);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }
  if (!(await consumeOneUse(env, row!.code, now))) {
    // Lost the race for the last use — indistinguishable from exhausted, and honest.
    return { ok: false, reason: 'exhausted' };
  }
  return {
    ok: true,
    claim: { storedCode: row!.code, source: row!.source, orgId: row!.orgId, role: row!.role },
  };
}

/** Reader-facing reason a signup code was refused. Says WHAT IS WRONG — never a generic
 *  error, never a silent success. Same honest-status rule as the alert path. */
export function signupCodeMessage(reason: SignupCodeFailure): string {
  switch (reason) {
    case 'code_required':
      return 'An access code is required to create an account.';
    case 'not_found':
      return 'That access code was not recognised. Check it and try again.';
    case 'revoked':
      return 'That access code has been cancelled. Contact whoever issued it.';
    case 'expired':
      return 'That access code has expired. Contact whoever issued it for a new one.';
    case 'exhausted':
      return 'That access code has already been used.';
    default:
      return 'That access code cannot be used.';
  }
}

/**
 * THE atomic consume — the ONE statement that claims a use of a code. Both redemption
 * paths (org enrollment and the signup gate) call this; there is deliberately no second
 * implementation, because two of these could disagree about what "already used" means.
 *
 * It is a CONDITIONAL update, never a read-then-write: every condition is re-checked
 * inside the same statement, so two concurrent requests racing on the last use of a code
 * cannot both win. SQLite applies the UPDATEs serially, the first moves usedCount to
 * maxUses, and the second matches zero rows. `changes === 1` is therefore the claim.
 */
export async function consumeOneUse(env: Env, storedCode: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE enrollment_codes SET usedCount = usedCount + 1 WHERE code = ? AND revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR expiresAt > ?)',
  )
    .bind(storedCode, now)
    .run();
  return res.meta.changes === 1;
}

/** Give a claimed use back when the work it was claimed FOR did not complete. Without
 *  this, a failed signup would silently burn a code the buyer paid for. */
export async function releaseOneUse(env: Env, storedCode: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE enrollment_codes SET usedCount = usedCount - 1 WHERE code = ? AND usedCount > 0',
  )
    .bind(storedCode)
    .run();
}

/** Record WHO consumed a code. usedCount already says whether; support and refunds
 *  need by-whom. Best-effort: never fails a completed redemption. */
export async function markRedeemed(env: Env, storedCode: string, userId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE enrollment_codes SET redeemedBy = COALESCE(redeemedBy, ?), redeemedAt = COALESCE(redeemedAt, ?) WHERE code = ?',
  )
    .bind(userId, now, storedCode)
    .run();
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
  // Use the RESOLVED stored code for every write — the user's raw input may differ in
  // case/dashes from the normalized stored form (Brief 28 §4).
  const storedCode = row!.code;
  if (!(await consumeOneUse(env, storedCode, now))) return { ok: false, reason: 'exhausted' };

  if (!row!.orgId) {
    // A consumer code has no org to bind to and must never reach the org path. Give the
    // use back so a mis-routed consumer code is not silently burned.
    await releaseOneUse(env, storedCode);
    return { ok: false, reason: 'not_found' };
  }
  const bind = await bindAccountToOrg(env, { userId, orgId: row!.orgId, role: row!.role });
  if (!bind.ok) {
    // Give the use back — the bind was refused (seats full / already in another org),
    // so this redemption did not actually enroll anyone.
    await releaseOneUse(env, storedCode);
    return { ok: false, reason: bind.reason };
  }
  await markRedeemed(env, storedCode, userId, now);
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
