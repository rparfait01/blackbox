/**
 * Console scope rules (Brief 33b) — THE boundary, expressed as pure functions.
 *
 * The point of the console is not the tables. It is that role and scope are decided by
 * the SERVER, per request, from the authenticated session — and that the client only
 * ever renders what the server already agreed to send. A hidden button is not a
 * boundary; a query that cannot name another org is.
 *
 * These rules live here, decoupled from D1 and from Hono, for one reason: every one of
 * them is a refusal, and a refusal that is only exercised through a live HTTP round trip
 * is a refusal nobody can unit-test. routes/console.ts holds the I/O; this holds the
 * decisions, so each branch is provable in isolation and cannot quietly widen.
 *
 * Two role systems meet here and are deliberately NOT merged:
 *   users.platform_role   — 'operator' or NULL. Cross-org by nature; the ONLY role that
 *                           crosses an org boundary (migration 0042).
 *   org_members.role      — 'admin' | 'coordinator'. Roles WITHIN one organisation,
 *                           always scoped by orgId (migration 0031).
 */

/** The four levels the console can present. Derived, never stored as one field. */
export type ConsoleLevel = 'operator' | 'admin' | 'coordinator' | 'unmarked';

/**
 * The UI labels. DISPLAY ONLY — the underlying fields keep their names
 * (platform_role='operator', org_members.role='admin'|'coordinator'). Renaming a
 * CHECK-constrained column to match a label would be a migration in service of a word.
 */
export const LEVEL_LABEL: Record<ConsoleLevel, string> = {
  operator: 'DEV',
  admin: 'ADMIN',
  coordinator: 'COORD',
  unmarked: 'UNMARKED',
};

export interface ConsoleIdentity {
  level: ConsoleLevel;
  /**
   * The ONE org this console session may touch, or null. Null means two different
   * things that are never confusable in practice because `level` disambiguates them:
   * for an operator, "no single org — all of them"; for unmarked, "none at all".
   */
  orgId: string | null;
}

/**
 * Resolve a caller's console level from server-side facts ONLY.
 *
 * Operator WINS over an org membership. An operator who also happens to be staff
 * somewhere is still an operator: demoting them to their org role would silently
 * narrow the one role that is supposed to be cross-org, and which org they landed in
 * would then depend on a LIMIT 1 over org_members.
 *
 * A membership only counts when it is ACTIVE — the caller passes an already-filtered
 * row, so a revoked seat cannot produce a level here at all.
 */
export function deriveConsoleLevel(input: {
  platformRole: string | null;
  membership: { orgId: string; role: 'admin' | 'coordinator' } | null;
}): ConsoleIdentity {
  if (input.platformRole === 'operator') {
    return { level: 'operator', orgId: null };
  }
  if (input.membership) {
    return { level: input.membership.role, orgId: input.membership.orgId };
  }
  return { level: 'unmarked', orgId: null };
}

/**
 * The account-level indicator (§1). The same derivation as above, reduced to the label
 * a row displays, so a level shown in the operator's account list and a level enforced
 * on a request can never disagree — there is one rule and both read it.
 */
export function accountLevelLabel(input: {
  platformRole: string | null;
  membership: { orgId: string; role: 'admin' | 'coordinator' } | null;
}): string {
  return LEVEL_LABEL[deriveConsoleLevel(input).level];
}

/** Enrollment-code roles the console can mint. `admin` is deliberately absent — see below. */
export type IssuableRole = 'survivor' | 'coordinator';

/**
 * May this level mint an enrollment code for this role?
 *
 *   coordinator → survivor only          (least privilege: cannot staff its own org)
 *   admin       → survivor, coordinator  (staffs its own org)
 *   operator    → survivor, coordinator  (same ceiling — see the admin note)
 *   unmarked    → nothing
 *
 * NOBODY — including the operator — can mint an `admin` ENROLLMENT code here, and that
 * is not an oversight. Brief 24 §2 made admin reachable ONLY through the registration
 * ceremony (a different table, a different single-use code, an explicit acceptance POST).
 * An enrollment code that could confer admin would reopen exactly the door acceptance
 * check 51 exists to keep shut. Operators issue admin REGISTRATION codes instead.
 */
export function mayIssueCodeRole(level: ConsoleLevel, role: string): role is IssuableRole {
  if (role !== 'survivor' && role !== 'coordinator') {
    return false;
  }
  switch (level) {
    case 'operator':
    case 'admin':
      return true;
    case 'coordinator':
      return role === 'survivor';
    default:
      return false;
  }
}

/**
 * How wide a code list this level may see.
 *   all  — every code in every org (operator only)
 *   org  — every code under the caller's own org
 *   own  — only the codes this caller personally issued
 *   none — nothing
 * The route turns this into SQL predicates; it never takes an org from the client.
 */
export type CodeVisibility = 'all' | 'org' | 'own' | 'none';

export function codeVisibility(level: ConsoleLevel): CodeVisibility {
  switch (level) {
    case 'operator':
      return 'all';
    case 'admin':
      return 'org';
    case 'coordinator':
      return 'own';
    default:
      return 'none';
  }
}

/**
 * How wide an enrollment ROSTER this level may see. The operator gets NONE on purpose:
 * the operator's job is orgs, codes and platform health, and a roster — even a
 * readiness-only one — is the closest thing in this product to a list of survivors. The
 * only role that crosses org boundaries is the one that has the least reason to read
 * per-person rows, so it does not get them.
 */
export function rosterVisibility(level: ConsoleLevel): 'org' | 'own' | 'none' {
  switch (level) {
    case 'admin':
      return 'org';
    case 'coordinator':
      return 'own';
    default:
      return 'none';
  }
}

/**
 * Readiness — the ONLY per-enrollee state the console ever shows, and it is computed
 * from operational signals: is the account activated, and can at least one confirmed
 * recipient actually be reached. No name, no number, no location, no incident content
 * is an input here, so none can be an output.
 *
 * `not_redeemed` is a real and distinct state: an issued code nobody has used yet has no
 * account behind it, and reporting that as "not ready" would blame a person who does not
 * exist.
 */
export type ReadinessState = 'armed' | 'not_ready' | 'not_redeemed';

export function readinessState(input: {
  redeemed: boolean;
  activated: boolean;
  reachableRecipient: boolean;
}): ReadinessState {
  if (!input.redeemed) {
    return 'not_redeemed';
  }
  return input.activated && input.reachableRecipient ? 'armed' : 'not_ready';
}

/**
 * Derived status of a code, shared by every console code list so operator, admin and
 * coordinator cannot each invent their own idea of "still usable". Mirrors the
 * conditions in consumeOneUse (enrollment.ts) — the atomic primitive is the authority;
 * this only describes what it would decide.
 */
export type CodeStatus = 'revoked' | 'expired' | 'exhausted' | 'active';

export function codeStatus(
  row: { revoked: number; expiresAt: number | null; maxUses: number; usedCount: number },
  now: number,
): CodeStatus {
  if (row.revoked) return 'revoked';
  if (row.expiresAt != null && row.expiresAt <= now) return 'expired';
  if (row.usedCount >= row.maxUses) return 'exhausted';
  return 'active';
}
