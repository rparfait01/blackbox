/**
 * Org tenancy helpers (Brief 23). Isolation is the paramount property: every
 * org-scoped read/write filters by the coordinator's session `orgId`, resolved
 * server-side from the account — never supplied by the client. This module holds the
 * pure authorization rules (testable in isolation) plus the small D1 helpers the
 * portal routes and enrollment share.
 */
import type { Env, OrgLicenseRow, OrganizationRow } from '../types';

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

/** Load an org row (or null). */
export async function getOrg(env: Env, orgId: string): Promise<OrganizationRow | null> {
  return env.DB.prepare(
    'SELECT id, name, status, lane, orgPubkey, createdAt FROM organizations WHERE id = ?',
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
