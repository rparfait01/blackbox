/**
 * Org tenancy helpers (Brief 23). Isolation is the paramount property: every
 * org-scoped read/write filters by the coordinator's session `orgId`, resolved
 * server-side from the account — never supplied by the client. This module holds the
 * pure authorization rules (testable in isolation) plus the small D1 helpers the
 * portal routes and enrollment share.
 */
import { generateReadableCode } from './readable-code';

import type { Env, EnrollmentCodeRow, OrgLicenseRow, OrganizationRow } from '../types';
import { readConsistent } from './consistent-read';

/**
 * Least-privilege role check. `admin` satisfies any requirement; `coordinator`
 * satisfies only coordinator-level. There is no cross-org escalation anywhere — the
 * org is always the member's own. Pure: the authorization rule, decoupled from D1.
 */
export function roleSatisfies(
  required: 'admin' | 'coordinator',
  actual: 'admin' | 'coordinator',
): boolean {
  if (required === 'admin') return actual === 'admin';
  return actual === 'admin' || actual === 'coordinator';
}

/**
 * The seat ceiling rule (purchase path). seatsUsed counts ENROLLED SURVIVORS;
 * enrolling one more is refused once used has reached total. Pure so the ceiling is
 * testable without D1. A license with seatsTotal 0 admits no survivors.
 */
export function seatCeilingReached(license: { seatsTotal: number; seatsUsed: number }): boolean {
  return license.seatsUsed >= license.seatsTotal;
}

// --- §4 Purchase: org + license records (NO payment processing anywhere) ---

/** Create an organization (operator action). lane is a label only. */
export async function createOrg(
  env: Env,
  input: { name: string; lane: 'zero_fee' | 'paid' },
): Promise<OrganizationRow> {
  const row: OrganizationRow = {
    id: crypto.randomUUID(),
    name: input.name,
    status: 'active',
    lane: input.lane,
    orgPubkey: null,
    createdAt: Date.now(),
    // License acceptance is recorded later, when admin #1 registers (Brief 24 §4).
    licenseAcceptedBy: null,
    licenseAcceptedAt: null,
    licenseVersion: null,
    licenseAcceptancePath: null,
  };
  await env.DB.prepare(
    'INSERT INTO organizations (id, name, status, lane, orgPubkey, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.name, row.status, row.lane, row.orgPubkey, row.createdAt)
    .run();
  return row;
}

/** Record a license against an org (operator action). RECORD ONLY — no checkout,
 *  no card, no payment. seatsUsed starts at 0 and tracks enrolled survivors. */
export async function recordLicense(
  env: Env,
  input: { orgId: string; seatsTotal: number; termStart: number | null; termEnd: number | null },
): Promise<OrgLicenseRow> {
  const row: OrgLicenseRow = {
    id: crypto.randomUUID(),
    orgId: input.orgId,
    seatsTotal: Math.max(0, Math.floor(input.seatsTotal)),
    seatsUsed: 0,
    termStart: input.termStart,
    termEnd: input.termEnd,
    status: 'active',
    createdAt: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO org_licenses (id, orgId, seatsTotal, seatsUsed, termStart, termEnd, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.orgId, row.seatsTotal, row.seatsUsed, row.termStart, row.termEnd, row.status, row.createdAt)
    .run();
  return row;
}

/**
 * THE code minter (Brief 30 §B). Unguessable, usage-bounded, and the ONLY place a code
 * is generated — shared by the operator bootstrap, the coordinator issue-code endpoint,
 * the institutional admin issuance, and the consumer (Gumroad) path. One generator, so
 * two issuance paths cannot drift into two alphabets or two length policies.
 *
 * `source` selects which kind of code this is, and the DB CHECK enforces the pairing:
 *   institutional → orgId REQUIRED  (enrolls into that org; a leaked code grants
 *                                    MEMBERSHIP ONLY, never data access)
 *   consumer      → orgId MUST be null (a buyer belongs to no organisation)
 */
export async function createEnrollmentCode(
  env: Env,
  input: {
    orgId: string | null;
    role: 'survivor' | 'coordinator' | 'admin';
    source?: 'consumer' | 'institutional';
    maxUses?: number;
    expiresAt?: number | null;
    createdBy?: string | null;
    /** Consumer only — where the code was delivered, for support and refunds. */
    buyerEmail?: string | null;
  },
): Promise<EnrollmentCodeRow> {
  const source = input.source ?? 'institutional';
  // Fail loudly rather than let the DB CHECK reject an insert we could have caught: a
  // consumer code with an org, or an institutional code without one, is a programming
  // error at the call site, not a user error.
  if (source === 'institutional' && !input.orgId) {
    throw new Error('createEnrollmentCode: institutional code requires an orgId');
  }
  if (source === 'consumer' && input.orgId) {
    throw new Error('createEnrollmentCode: consumer code must not carry an orgId');
  }
  const row: EnrollmentCodeRow = {
    // Brief 28 §4 — readable Crockford code (no 0/O/1/I/L confusables), stored
    // normalized. Redeemed after normalization, so dashes/case on entry don't matter;
    // legacy hex codes still redeem by exact match. Rate-limited at redemption.
    code: generateReadableCode(10),
    source,
    orgId: input.orgId,
    role: input.role,
    expiresAt: input.expiresAt ?? null,
    maxUses: input.maxUses && input.maxUses > 0 ? Math.floor(input.maxUses) : 1,
    usedCount: 0,
    revoked: 0,
    createdBy: input.createdBy ?? null,
    createdAt: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO enrollment_codes (code, source, orgId, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt, buyerEmail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      row.code,
      row.source,
      row.orgId,
      row.role,
      row.expiresAt,
      row.maxUses,
      row.usedCount,
      row.revoked,
      row.createdBy,
      row.createdAt,
      input.buyerEmail ?? null,
    )
    .run();
  return row;
}

/** Load an org row (or null). */
export async function getOrg(env: Env, orgId: string): Promise<OrganizationRow | null> {
  return env.DB.prepare(
    'SELECT id, name, status, lane, orgPubkey, createdAt, licenseAcceptedBy, licenseAcceptedAt, licenseVersion, licenseAcceptancePath FROM organizations WHERE id = ?',
  )
    .bind(orgId)
    .first<OrganizationRow>();
}

// --- Brief 24: minimum-admin enforcement (lives here so both enrollment.ts and
// org-registration.ts can use it without a circular import) ---

/** Minimum admins an org must have. Enforced: the system refuses to drop below this. */
export const MIN_ADMINS = 2;

/** Count an org's ACTIVE admins (org_members role=admin, status=active). */
/**
 * READ FROM THE PRIMARY. This count GATES a user-visible refusal, so a stale replica makes the
 * refusal a lie.
 *
 * The failure it fixes: an org adds its second admin, the write commits, the next request counts
 * admins on a replica that has not caught up, and the org is told "Add a second admin before
 * enrolling survivors" — immediately after adding one, with nothing they can do about it.
 *
 * Surfaced as an intermittent acceptance failure that passed in isolation and failed under load.
 * The flake was the symptom; the defect was real. Same class as the Brief 37 chain head, and the
 * same lesson: serializing callers cannot repair an eventually-consistent read.
 */
export async function countActiveAdmins(env: Env, orgId: string): Promise<number> {
  const row = await readConsistent(env, (db) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM org_members WHERE orgId = ? AND role = 'admin' AND status = 'active'")
      .bind(orgId)
      .first<{ n: number }>(),
  );
  return Number(row?.n ?? 0);
}

/** Seat issuance (enrolling survivors) is locked until the org has MIN_ADMINS admins
 *  (§5). No survivor is enrolled into an org not yet staffed with two accountable
 *  admins. */
export async function seatIssuanceLocked(env: Env, orgId: string): Promise<boolean> {
  return (await countActiveAdmins(env, orgId)) < MIN_ADMINS;
}

/**
 * May this admin be removed? Blocked when it would drop the org below MIN_ADMINS while
 * at least MIN_ADMINS exist — i.e. you cannot remove the second-to-last admin (§0/§6).
 * The bootstrap window (a sole admin #1 before #2 is added) is NOT blocked here; that
 * 1→0 case is recovered by the operator re-issue path.
 */
export async function adminRemovalBlocked(env: Env, orgId: string): Promise<boolean> {
  const admins = await countActiveAdmins(env, orgId);
  return admins >= MIN_ADMINS && admins - 1 < MIN_ADMINS;
}

/** The org's active license, if any. seatsUsed counts enrolled survivors. */
export async function getActiveLicense(env: Env, orgId: string): Promise<OrgLicenseRow | null> {
  return env.DB.prepare(
    "SELECT id, orgId, seatsTotal, seatsUsed, termStart, termEnd, status, createdAt FROM org_licenses WHERE orgId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
  )
    .bind(orgId)
    .first<OrgLicenseRow>();
}
