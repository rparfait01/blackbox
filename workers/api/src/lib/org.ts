/**
 * Org tenancy helpers (Brief 23). Isolation is the paramount property: every
 * org-scoped read/write filters by the coordinator's session `orgId`, resolved
 * server-side from the account — never supplied by the client. This module holds the
 * pure authorization rules (testable in isolation) plus the small D1 helpers the
 * portal routes and enrollment share.
 */
import { randomHex } from '@blackbox/shared';

import type { Env, EnrollmentCodeRow, OrgLicenseRow, OrganizationRow } from '../types';

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

/** Mint an enrollment code (unguessable, usage-bounded). Shared by the operator
 *  bootstrap (admin code) and the coordinator issue-code endpoint. A leaked code
 *  grants MEMBERSHIP ONLY — never read access to any survivor's data. */
export async function createEnrollmentCode(
  env: Env,
  input: {
    orgId: string;
    role: 'survivor' | 'coordinator' | 'admin';
    maxUses?: number;
    expiresAt?: number | null;
    createdBy?: string | null;
  },
): Promise<EnrollmentCodeRow> {
  const row: EnrollmentCodeRow = {
    code: randomHex(16), // 128 bits — unguessable
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
    'INSERT INTO enrollment_codes (code, orgId, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      row.code,
      row.orgId,
      row.role,
      row.expiresAt,
      row.maxUses,
      row.usedCount,
      row.revoked,
      row.createdBy,
      row.createdAt,
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

/** The org's active license, if any. seatsUsed counts enrolled survivors. */
export async function getActiveLicense(env: Env, orgId: string): Promise<OrgLicenseRow | null> {
  return env.DB.prepare(
    "SELECT id, orgId, seatsTotal, seatsUsed, termStart, termEnd, status, createdAt FROM org_licenses WHERE orgId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
  )
    .bind(orgId)
    .first<OrgLicenseRow>();
}
