/**
 * THE CONSOLE (Brief 33b + 33c). One shell, three levels, decided by the server.
 *
 * The whole point of this surface is NOT the tables — it is that role and org scope are
 * resolved SERVER-SIDE, per request, from the authenticated session, and that no handler
 * anywhere below takes an org from the client. A hidden button is not a boundary. What
 * makes org A unreachable from org B is that the SQL cannot name org B: every scoped
 * query binds `identity.orgId`, which came from an ACTIVE org_members row, which came
 * from the session's userId.
 *
 * THE INVARIANTS, stated once so every handler can be read against them:
 *
 *   [A] Operator is the ONLY level that crosses an org boundary. Every other level is
 *       pinned to exactly one org for the lifetime of the request.
 *   [A] NO level — operator included — can read incident CONTENT. There is deliberately
 *       no route here that touches chunks_index, MEDIA, transcripts, locations, case
 *       files, or plaintext commitments. Counters and metadata only. This is pinned by
 *       console-boundary.guard.test.ts, which greps this file for those tables.
 *   [A] All code operations reuse the unified `enrollment_codes` table and the ONE
 *       atomic primitive (consumeOneUse / createEnrollmentCode). No second code system.
 *   [A] Every maintenance action is audited with the ACTING PERSON's userId — not null,
 *       not "operator" the string. Brief 33a made the operator an identity precisely so
 *       "who purged R2?" has an answer.
 *
 * Destructive maintenance is DRY-RUN BY DEFAULT: `confirm: true` is required, and an
 * absent/malformed body previews rather than deletes.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { hasReachableRecipient } from '@blackbox/shared';

import { requireSession } from '../auth';
import { isChannelDeliverable } from '../channels/router';
import { audit } from '../lib/audit';
import { consentGateEnforced } from '../lib/consent';
import {
  accountLevelLabel,
  codeStatus,
  codeVisibility,
  deriveConsoleLevel,
  LEVEL_LABEL,
  mayIssueCodeRole,
  navFor,
  readinessState,
  rosterVisibility,
  type ConsoleIdentity,
  type ConsoleLevel,
} from '../lib/console-scope';
import { MIGRATIONS_AT_BUILD } from '../lib/migration-manifest';
import { purgeOrphanedMedia } from '../lib/media-purge';
import { adminRemovalBlocked, createEnrollmentCode, createOrg, getActiveLicense, recordLicense } from '../lib/org';
import {
  createAdminRegistrationCode,
  reissueRegistrationCode,
  revokeRegistrationCode,
} from '../lib/org-registration';
import { leaveOrg } from '../lib/enrollment';
import { deleteAccount } from '../lib/users';
import type { Env, Vars } from '../types';

export const consoleRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 30 days, the window every "activations · 30d" counter in the console uses. */
const WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000;
/** Ceiling on any console list. Large enough for the pilot, bounded so no query is unbounded. */
const LIST_LIMIT = 200;

// A valid account session is required for the entire surface — the level gate runs
// after it, never instead of it. An unauthenticated caller is 401 before any role logic
// is reached, so arming a new console route can never expose an open endpoint.
consoleRoutes.use('*', requireSession);

/**
 * Resolve WHO this is, in console terms, from the database — the only place the level
 * and the org are decided. Runs on every console request; nothing downstream re-derives
 * it and nothing downstream accepts an override.
 */
consoleRoutes.use('*', async (c, next) => {
  const userId = c.get('userId');
  const [account, membership] = await Promise.all([
    c.env.DB.prepare('SELECT platform_role, name, email FROM users WHERE id = ?')
      .bind(userId)
      .first<{ platform_role: string | null; name: string | null; email: string | null }>(),
    // ACTIVE only: a revoked seat produces no membership, so access ends the instant it
    // is revoked rather than at the next sign-in.
    c.env.DB.prepare(
      "SELECT orgId, role FROM org_members WHERE userId = ? AND status = 'active' LIMIT 1",
    )
      .bind(userId)
      .first<{ orgId: string; role: 'admin' | 'coordinator' }>(),
  ]);
  const identity = deriveConsoleLevel({
    platformRole: account?.platform_role ?? null,
    membership: membership ?? null,
  });
  c.set('consoleLevel', identity.level);
  c.set('consoleOrgId', identity.orgId);
  c.set('consoleName', account?.name ?? account?.email ?? null);
  await next();
  return undefined;
});

type ConsoleContext = Context<{ Bindings: Env; Variables: Vars }>;

function identityOf(c: ConsoleContext): ConsoleIdentity {
  return {
    level: (c.get('consoleLevel') ?? 'unmarked') as ConsoleLevel,
    orgId: c.get('consoleOrgId') ?? null,
  };
}

/**
 * Gate a route to specific levels. The refusal NAMES the level the caller actually has,
 * because a console that says only "forbidden" leaves a coordinator unable to tell a
 * permissions problem from a broken build.
 */
function requireLevel(...allowed: ConsoleLevel[]): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const level = (c.get('consoleLevel') ?? 'unmarked') as ConsoleLevel;
    if (!allowed.includes(level)) {
      return c.json(
        {
          error: 'level_forbidden',
          level,
          message: `This action requires ${allowed.map((l) => LEVEL_LABEL[l]).join(' or ')}. You are ${LEVEL_LABEL[level]}.`,
        },
        403,
      );
    }
    await next();
    return undefined;
  };
}

/** The org an org-scoped handler may touch. Never a parameter, never a body field. */
function scopedOrg(c: ConsoleContext): string {
  return c.get('consoleOrgId') as string;
}

// =====================================================================
// WHO AM I  — the only route every level may call
// =====================================================================

consoleRoutes.get('/me', async (c) => {
  const identity = identityOf(c);
  const org = identity.orgId
    ? await c.env.DB.prepare('SELECT id, name, lane, status FROM organizations WHERE id = ?')
        .bind(identity.orgId)
        .first<{ id: string; name: string; lane: string; status: string }>()
    : null;
  return c.json(
    {
      userId: c.get('userId'),
      displayName: c.get('consoleName') ?? null,
      level: identity.level,
      levelLabel: LEVEL_LABEL[identity.level],
      orgId: identity.orgId,
      orgName: org?.name ?? null,
      // The NAV, built server-side for this level. The client renders exactly these
      // items and derives none of its own: a coordinator's response does not contain
      // "Maintenance" at all. This is not what enforces the boundary — the endpoints
      // refuse independently — but it means the UI cannot invent a link the server
      // would only reject, and cannot leave a reachable view without a way in.
      nav: navFor(identity.level),
      // What the client may render. The server has ALREADY refused everything not in
      // here — this exists so the UI does not paint controls that would only 403, never
      // as the thing that stops the request.
      may: {
        orgs: identity.level === 'operator',
        accounts: identity.level === 'operator',
        maintenance: identity.level === 'operator',
        seats: identity.level === 'admin',
        codes: identity.level !== 'unmarked',
        roster: rosterVisibility(identity.level) !== 'none',
        issueRoles: (['survivor', 'coordinator'] as const).filter((r) =>
          mayIssueCodeRole(identity.level, r),
        ),
      },
    },
    200,
  );
});

// =====================================================================
// OVERVIEW — operational counters, per scope. NEVER derived from incident content:
// every number below counts orgs, accounts, codes or event ROWS. Nothing reads a
// capture, a transcript, a location or a case file.
//
// Brief 35 §C — every activation count here filters `isTest = 0`. A deploy canary opens
// a real event through the real trigger path (that is the only way it can prove the path
// exists), so without this filter each deploy would silently inflate "activations in the
// last 30 days" — a number an org reads as "how often did our people need this". A
// coverage metric that counts our own test runs is worse than no metric.
// =====================================================================

consoleRoutes.get('/overview', requireLevel('operator', 'admin', 'coordinator'), async (c) => {
  const identity = identityOf(c);
  const since = Date.now() - WINDOW_30D_MS;

  if (identity.level === 'operator') {
    const [orgs, enrolled, activations, openCodes] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM organizations').first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE orgId IS NOT NULL').first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE createdAt >= ? AND isTest = 0')
        .bind(since)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM enrollment_codes WHERE revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR expiresAt > ?)',
      )
        .bind(Date.now())
        .first<{ n: number }>(),
    ]);
    return c.json(
      {
        scope: 'system',
        metrics: {
          organizations: Number(orgs?.n ?? 0),
          enrolled: Number(enrolled?.n ?? 0),
          activations30d: Number(activations?.n ?? 0),
          openCodes: Number(openCodes?.n ?? 0),
        },
      },
      200,
    );
  }

  const orgId = scopedOrg(c);
  if (identity.level === 'admin') {
    const [license, coordinators, activations, openCodes] = await Promise.all([
      getActiveLicense(c.env, orgId),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM org_members WHERE orgId = ? AND role = 'coordinator' AND status = 'active'",
      )
        .bind(orgId)
        .first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE orgId = ? AND createdAt >= ? AND isTest = 0')
        .bind(orgId, since)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM enrollment_codes WHERE orgId = ? AND revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR expiresAt > ?)',
      )
        .bind(orgId, Date.now())
        .first<{ n: number }>(),
    ]);
    return c.json(
      {
        scope: 'org',
        orgId,
        metrics: {
          seatsUsed: license?.seatsUsed ?? 0,
          seatsTotal: license?.seatsTotal ?? 0,
          coordinators: Number(coordinators?.n ?? 0),
          activations30d: Number(activations?.n ?? 0),
          openCodes: Number(openCodes?.n ?? 0),
        },
      },
      200,
    );
  }

  // Coordinator: their OWN issuance only. `createdBy = self` is the whole scope.
  const userId = c.get('userId');
  const [issued, openCodes, roster] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM enrollment_codes WHERE orgId = ? AND createdBy = ?')
      .bind(orgId, userId)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM enrollment_codes WHERE orgId = ? AND createdBy = ? AND revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR expiresAt > ?)',
    )
      .bind(orgId, userId, Date.now())
      .first<{ n: number }>(),
    loadRoster(c.env, { orgId, createdBy: userId }),
  ]);
  return c.json(
    {
      scope: 'own',
      orgId,
      metrics: {
        codesIssued: Number(issued?.n ?? 0),
        openCodes: Number(openCodes?.n ?? 0),
        enrollments: roster.length,
        notReady: roster.filter((r) => r.state === 'not_ready').length,
        activations30d: roster.reduce((a, r) => a + r.activations30d, 0),
      },
    },
    200,
  );
});

// =====================================================================
// ORGANISATIONS — operator only. The one place a level legitimately sees every org.
// =====================================================================

consoleRoutes.get('/orgs', requireLevel('operator'), async (c) => {
  const since = Date.now() - WINDOW_30D_MS;
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.lane, o.status, o.createdAt,
            (SELECT seatsTotal FROM org_licenses l WHERE l.orgId = o.id AND l.status = 'active' ORDER BY l.createdAt DESC LIMIT 1) AS seatsTotal,
            (SELECT seatsUsed  FROM org_licenses l WHERE l.orgId = o.id AND l.status = 'active' ORDER BY l.createdAt DESC LIMIT 1) AS seatsUsed,
            (SELECT COUNT(*) FROM users u WHERE u.orgId = o.id) AS enrolled,
            (SELECT COUNT(*) FROM events e WHERE e.orgId = o.id AND e.createdAt >= ? AND e.isTest = 0) AS activations30d,
            (SELECT COUNT(*) FROM org_members m WHERE m.orgId = o.id AND m.role = 'admin' AND m.status = 'active') AS admins
       FROM organizations o ORDER BY o.createdAt DESC LIMIT ?`,
  )
    .bind(since, LIST_LIMIT)
    .all<{
      id: string; name: string; lane: string; status: string; createdAt: number;
      seatsTotal: number | null; seatsUsed: number | null; enrolled: number; activations30d: number; admins: number;
    }>();
  return c.json(
    {
      orgs: (results ?? []).map((o) => ({
        orgId: o.id,
        name: o.name,
        lane: o.lane,
        status: o.status,
        createdAt: o.createdAt,
        seatsTotal: Number(o.seatsTotal ?? 0),
        seatsUsed: Number(o.seatsUsed ?? 0),
        enrolled: Number(o.enrolled),
        activations30d: Number(o.activations30d),
        adminCount: Number(o.admins),
        // Brief 24 §5 — an org with fewer than two admins cannot enrol anyone yet. The
        // operator needs to see that, because they are the escape hatch when it stalls.
        seatsLocked: Number(o.admins) < 2,
      })),
    },
    200,
  );
});

/**
 * Vet + create an organisation, and issue the one-time ADMIN REGISTRATION code (§3).
 * Identical machinery to POST /v1/admin/orgs — deliberately the same three calls, not a
 * reimplementation — so the console button and the operator's script cannot diverge into
 * two ideas of what creating an org means. Orgs are NEVER self-serve: the vetting happens
 * out of band, and this records the result.
 */
consoleRoutes.post('/orgs', requireLevel('operator'), async (c) => {
  const actor = c.get('userId');
  const body = await c.req
    .json<{ name?: string; lane?: string; seatsTotal?: number; termStart?: number; termEnd?: number }>()
    .catch(() => ({}) as Record<string, never>);
  const name = (body.name ?? '').trim();
  const lane = body.lane === 'paid' ? 'paid' : body.lane === 'zero_fee' ? 'zero_fee' : null;
  if (!name || !lane) {
    return c.json({ error: 'name_and_lane_required', message: 'A name and a lane (zero_fee | paid) are required.' }, 400);
  }
  const seatsTotal = typeof body.seatsTotal === 'number' && body.seatsTotal >= 0 ? Math.floor(body.seatsTotal) : 0;
  const org = await createOrg(c.env, { name, lane });
  const license = await recordLicense(c.env, {
    orgId: org.id,
    seatsTotal,
    termStart: typeof body.termStart === 'number' ? body.termStart : null,
    termEnd: typeof body.termEnd === 'number' ? body.termEnd : null,
  });
  const reg = await createAdminRegistrationCode(c.env, { orgId: org.id, createdBy: actor });
  await audit(c.env, null, 'console.org_create', actor, { orgId: org.id, lane, seatsTotal });
  return c.json(
    {
      orgId: org.id,
      name: org.name,
      lane: org.lane,
      licenseId: license.id,
      seatsTotal,
      registrationCode: reg.code,
      registrationExpiresAt: reg.expiresAt,
    },
    201,
  );
});

/** Re-issue an org's admin registration code (logged, reason required). */
consoleRoutes.post('/orgs/:orgId/admin-code', requireLevel('operator'), async (c) => {
  const actor = c.get('userId');
  const orgId = c.req.param('orgId');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return c.json({ error: 'reason_required', message: 'A reason is required — this is a logged privileged action.' }, 400);
  }
  const fresh = await reissueRegistrationCode(c.env, orgId, reason, actor);
  await audit(c.env, null, 'console.admin_code_reissue', actor, { orgId, reason });
  return c.json({ registrationCode: fresh.code, registrationExpiresAt: fresh.expiresAt }, 201);
});

/** Revoke a live admin registration code (logged, reason required). */
consoleRoutes.post('/orgs/:orgId/admin-code/revoke', requireLevel('operator'), async (c) => {
  const actor = c.get('userId');
  const orgId = c.req.param('orgId');
  const body = await c.req.json<{ code?: string; reason?: string }>().catch(() => ({}) as Record<string, never>);
  const code = (body.code ?? '').trim();
  const reason = (body.reason ?? '').trim();
  if (!code || !reason) {
    return c.json({ error: 'code_and_reason_required', message: 'A code and a reason are required.' }, 400);
  }
  const ok = await revokeRegistrationCode(c.env, code, reason, actor);
  if (!ok) {
    return c.json({ error: 'code_not_found_or_already_redeemed' }, 404);
  }
  await audit(c.env, null, 'console.admin_code_revoke', actor, { orgId, reason });
  return c.json({ revoked: true }, 200);
});

/**
 * The org's live admin registration codes, so the operator can see what is outstanding
 * before issuing another. Codes only — no account data.
 */
consoleRoutes.get('/orgs/:orgId/admin-codes', requireLevel('operator'), async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT code, createdAt, expiresAt, redeemedAt, revoked FROM admin_registration_codes WHERE orgId = ? ORDER BY createdAt DESC LIMIT ?',
  )
    .bind(c.req.param('orgId'), LIST_LIMIT)
    .all<{ code: string; createdAt: number; expiresAt: number; redeemedAt: number | null; revoked: number }>();
  const now = Date.now();
  return c.json(
    {
      codes: (results ?? []).map((r) => ({
        code: r.code,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        // Redeemed BEFORE revoked: reissueRegistrationCode revokes outstanding codes, and
        // a code that was actually used should not later read as though it never was.
        status: r.redeemedAt ? 'redeemed' : r.revoked ? 'revoked' : r.expiresAt <= now ? 'expired' : 'active',
      })),
    },
    200,
  );
});

// =====================================================================
// ACCOUNTS — §1 level indicators. Operator only, because it spans every org.
// Identity fields only (who the account is and what level it holds); nothing about
// what any account has recorded.
// =====================================================================

consoleRoutes.get('/accounts', requireLevel('operator'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.createdAt, u.platform_role, u.orgId, u.entitlement,
            (SELECT m.role FROM org_members m WHERE m.userId = u.id AND m.status = 'active' LIMIT 1) AS memberRole,
            (SELECT m.orgId FROM org_members m WHERE m.userId = u.id AND m.status = 'active' LIMIT 1) AS memberOrgId,
            (SELECT o.name FROM organizations o WHERE o.id = u.orgId) AS orgName
       FROM users u ORDER BY u.createdAt DESC LIMIT ?`,
  )
    .bind(LIST_LIMIT)
    .all<{
      id: string; email: string | null; name: string | null; createdAt: number;
      platform_role: string | null; orgId: string | null; entitlement: string | null;
      memberRole: 'admin' | 'coordinator' | null; memberOrgId: string | null; orgName: string | null;
    }>();
  return c.json(
    {
      accounts: (results ?? []).map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        orgId: u.orgId,
        orgName: u.orgName,
        activated: u.entitlement === 'activated',
        // ONE derivation, shared with the request gate — a level shown here and a level
        // enforced on a request cannot disagree.
        level: accountLevelLabel({
          platformRole: u.platform_role,
          membership: u.memberRole && u.memberOrgId ? { orgId: u.memberOrgId, role: u.memberRole } : null,
        }),
      })),
    },
    200,
  );
});

// =====================================================================
// CODES — the unified enrollment_codes table, scoped three ways by ONE rule.
// =====================================================================

consoleRoutes.get('/codes', requireLevel('operator', 'admin', 'coordinator'), async (c) => {
  const identity = identityOf(c);
  const visibility = codeVisibility(identity.level);
  const now = Date.now();

  // The predicate IS the boundary. 'org' can only ever bind the caller's own orgId;
  // 'own' additionally pins createdBy to the caller. There is no branch that binds an
  // org id taken from the request.
  const where =
    visibility === 'all'
      ? { sql: '1 = 1', binds: [] as unknown[] }
      : visibility === 'org'
        ? { sql: 'ec.orgId = ?', binds: [identity.orgId] }
        : { sql: 'ec.orgId = ? AND ec.createdBy = ?', binds: [identity.orgId, c.get('userId')] };

  const { results } = await c.env.DB.prepare(
    `SELECT ec.code, ec.role, ec.orgId, ec.source, ec.expiresAt, ec.maxUses, ec.usedCount, ec.revoked,
            ec.createdBy, ec.createdAt, ec.redeemedAt,
            (SELECT o.name FROM organizations o WHERE o.id = ec.orgId) AS orgName,
            (SELECT COALESCE(iu.name, iu.email) FROM users iu WHERE iu.id = ec.createdBy) AS issuedBy
       FROM enrollment_codes ec WHERE ${where.sql} ORDER BY ec.createdAt DESC LIMIT ?`,
  )
    .bind(...where.binds, LIST_LIMIT)
    .all<{
      code: string; role: string; orgId: string | null; source: string; expiresAt: number | null;
      maxUses: number; usedCount: number; revoked: number; createdBy: string | null; createdAt: number;
      redeemedAt: number | null; orgName: string | null; issuedBy: string | null;
    }>();

  return c.json(
    {
      scope: visibility,
      codes: (results ?? []).map((r) => ({
        code: r.code,
        role: r.role,
        source: r.source,
        orgId: r.orgId,
        orgName: r.orgName,
        // Falls back to the raw createdBy for codes minted before the operator was an
        // identity ('operator' the string) — honest about what the record actually says.
        issuedBy: r.issuedBy ?? r.createdBy,
        usedCount: r.usedCount,
        maxUses: r.maxUses,
        usesLeft: Math.max(0, r.maxUses - r.usedCount),
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        redeemedAt: r.redeemedAt,
        status: codeStatus(r, now),
      })),
    },
    200,
  );
});

/**
 * Issue enrollment codes. The role a level may mint is authorised SERVER-SIDE against
 * `mayIssueCodeRole` — a coordinator asking for a coordinator code is refused here, not
 * hidden in the UI. Minting uses `createEnrollmentCode`, the ONE generator, so the
 * console cannot drift into its own alphabet, length or expiry policy.
 */
consoleRoutes.post('/codes', requireLevel('operator', 'admin', 'coordinator'), async (c) => {
  const identity = identityOf(c);
  const actor = c.get('userId');
  const body = await c.req
    .json<{ role?: string; count?: number; maxUses?: number; expiresInHours?: number; orgId?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const requested = (body.role ?? 'survivor').trim();

  if (!mayIssueCodeRole(identity.level, requested)) {
    return c.json(
      {
        error: 'role_forbidden',
        level: identity.level,
        message:
          requested === 'admin'
            ? 'Admin is never conferred by an enrollment code. Issue an admin registration code for the organisation instead.'
            : `${LEVEL_LABEL[identity.level]} cannot issue a ${requested} code.`,
      },
      403,
    );
  }

  // WHICH ORG. For staff this is their own, always — a body orgId is ignored, not
  // honoured-then-checked, so there is no path where a client value reaches the insert.
  // The operator is the one level that may name an org, and it must exist.
  let orgId: string;
  if (identity.level === 'operator') {
    const named = (body.orgId ?? '').trim();
    if (!named) {
      return c.json({ error: 'orgId_required', message: 'Choose the organisation this code enrols into.' }, 400);
    }
    const org = await c.env.DB.prepare('SELECT id FROM organizations WHERE id = ?').bind(named).first<{ id: string }>();
    if (!org) {
      return c.json({ error: 'org_not_found' }, 404);
    }
    orgId = org.id;
  } else {
    orgId = scopedOrg(c);
  }

  const count = Math.max(1, Math.min(Number(body.count ?? 1) || 1, 25));
  const maxUses = typeof body.maxUses === 'number' && body.maxUses > 0 ? Math.floor(body.maxUses) : 1;
  const expiresAt =
    typeof body.expiresInHours === 'number' && body.expiresInHours > 0
      ? Date.now() + body.expiresInHours * 3_600_000
      : null;

  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await createEnrollmentCode(c.env, {
      orgId,
      source: 'institutional',
      role: requested,
      maxUses,
      expiresAt,
      createdBy: actor,
    });
    codes.push(row.code);
  }
  await audit(c.env, null, 'console.code_issue', actor, { orgId, role: requested, count: codes.length, maxUses });
  return c.json({ codes, role: requested, orgId, maxUses, expiresAt }, 201);
});

/**
 * Revoke a code. The scope predicate is applied INSIDE the UPDATE, so a code outside the
 * caller's scope matches zero rows and comes back as not-found — the same answer as a
 * code that does not exist. A caller cannot use this endpoint to learn that another
 * org's code is real.
 */
consoleRoutes.post('/codes/:code/revoke', requireLevel('operator', 'admin', 'coordinator'), async (c) => {
  const identity = identityOf(c);
  const actor = c.get('userId');
  const code = c.req.param('code');
  const visibility = codeVisibility(identity.level);
  const scope =
    visibility === 'all'
      ? { sql: '', binds: [] as unknown[] }
      : visibility === 'org'
        ? { sql: ' AND orgId = ?', binds: [identity.orgId] }
        : { sql: ' AND orgId = ? AND createdBy = ?', binds: [identity.orgId, actor] };

  const res = await c.env.DB.prepare(`UPDATE enrollment_codes SET revoked = 1 WHERE code = ?${scope.sql}`)
    .bind(code, ...scope.binds)
    .run();
  if (res.meta.changes !== 1) {
    return c.json({ error: 'code_not_found' }, 404);
  }
  await audit(c.env, null, 'console.code_revoke', actor, { code, scope: visibility });
  return c.json({ revoked: true }, 200);
});

// =====================================================================
// SEATS — admin only, own org only. Staff membership, not survivors.
// =====================================================================

consoleRoutes.get('/seats', requireLevel('admin'), async (c) => {
  const orgId = scopedOrg(c);
  const { results } = await c.env.DB.prepare(
    `SELECT m.userId, m.role, m.status, m.createdAt, u.name, u.email, u.platform_role
       FROM org_members m JOIN users u ON u.id = m.userId
      WHERE m.orgId = ? ORDER BY m.createdAt ASC LIMIT ?`,
  )
    .bind(orgId, LIST_LIMIT)
    .all<{
      userId: string; role: 'admin' | 'coordinator'; status: string; createdAt: number;
      name: string | null; email: string | null; platform_role: string | null;
    }>();
  const rows = results ?? [];
  const activeAdmins = rows.filter((r) => r.role === 'admin' && r.status === 'active').length;
  return c.json(
    {
      orgId,
      adminCount: activeAdmins,
      // Surfaced so the UI can explain the locked control rather than just disabling it.
      // The refusal itself is enforced server-side on the removal/demotion routes.
      minAdmins: 2,
      seats: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        createdAt: r.createdAt,
        level: accountLevelLabel({
          platformRole: r.platform_role,
          membership: { orgId, role: r.role },
        }),
        // A removal that WOULD drop the org below two admins is refused by the server;
        // this only tells the UI which control to explain.
        removable: !(r.role === 'admin' && r.status === 'active' && activeAdmins <= 2),
      })),
    },
    200,
  );
});

/** Invite admin #2+ from inside — the registration ceremony, never an enrollment code. */
consoleRoutes.post('/seats/invite-admin', requireLevel('admin'), async (c) => {
  const orgId = scopedOrg(c);
  const actor = c.get('userId');
  const reg = await createAdminRegistrationCode(c.env, { orgId, createdBy: actor });
  await audit(c.env, null, 'console.admin_invite', actor, { orgId });
  return c.json({ registrationCode: reg.code, registrationExpiresAt: reg.expiresAt }, 201);
});

/**
 * Change a seat's role within the caller's own org. Demoting an admin is exactly as
 * dangerous as removing one — it drops the active-admin count identically — so it runs
 * through the SAME min-2-admins guard. A rule enforced on one route and not its twin is
 * not enforced.
 */
consoleRoutes.post('/seats/:userId/role', requireLevel('admin'), async (c) => {
  const orgId = scopedOrg(c);
  const actor = c.get('userId');
  const targetId = c.req.param('userId');
  const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
  const role = body.role === 'admin' ? 'admin' : body.role === 'coordinator' ? 'coordinator' : null;
  if (!role) {
    return c.json({ error: 'role_required', message: 'Role must be admin or coordinator.' }, 400);
  }
  // The orgId predicate is the isolation boundary: another org's member is not found.
  const member = await c.env.DB.prepare(
    "SELECT id, role FROM org_members WHERE orgId = ? AND userId = ? AND status = 'active'",
  )
    .bind(orgId, targetId)
    .first<{ id: string; role: 'admin' | 'coordinator' }>();
  if (!member) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (member.role === role) {
    return c.json({ ok: true, role, unchanged: true }, 200);
  }
  if (member.role === 'admin' && (await adminRemovalBlocked(c.env, orgId))) {
    return c.json(
      {
        error: 'min_admins',
        message: 'An organisation must keep at least two admins. Add another admin before changing this one.',
      },
      409,
    );
  }
  await c.env.DB.prepare('UPDATE org_members SET role = ? WHERE id = ?').bind(role, member.id).run();
  await audit(c.env, null, 'console.seat_role', actor, { orgId, targetId, from: member.role, to: role });
  return c.json({ ok: true, role }, 200);
});

/**
 * Remove a seat. Delegates to leaveOrg — the same routine the survivor's own "leave"
 * uses — so seat removal, self-removal and the org portal all revoke access one way:
 * users.orgId cleared and org_members set revoked, both read live on the next request.
 */
consoleRoutes.post('/seats/:userId/remove', requireLevel('admin'), async (c) => {
  const orgId = scopedOrg(c);
  const actor = c.get('userId');
  const targetId = c.req.param('userId');
  const target = await c.env.DB.prepare('SELECT orgId FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ orgId: string | null }>();
  if (!target || target.orgId !== orgId) {
    return c.json({ error: 'not_found' }, 404);
  }
  const res = await leaveOrg(c.env, targetId);
  if (!res.ok) {
    return c.json(
      { error: res.reason, message: 'An organisation must keep at least two admins. Add another admin before removing this one.' },
      409,
    );
  }
  await audit(c.env, null, 'console.seat_remove', actor, { orgId, targetId });
  return c.json({ removed: true }, 200);
});

// =====================================================================
// ROSTER — READINESS ONLY (admin: org-wide; coordinator: their own issuance).
//
// A survivor appears as the ENROLLMENT CODE they redeemed and nothing else. No name, no
// email, no phone number, no location, no incident content — and no account id either,
// because an id is a handle onto the person and the coordinator has no operation that
// needs one. What is here is what helps someone reach Armed: did they redeem, are they
// activated, can anyone actually be reached for them.
// =====================================================================

interface RosterRow {
  code: string;
  redeemedAt: number | null;
  state: ReturnType<typeof readinessState>;
  confirmedContacts: number;
  activations30d: number;
}

async function loadRoster(
  env: Env,
  scope: { orgId: string; createdBy?: string },
): Promise<RosterRow[]> {
  const where = scope.createdBy
    ? { sql: "ec.orgId = ? AND ec.role = 'survivor' AND ec.createdBy = ?", binds: [scope.orgId, scope.createdBy] }
    : { sql: "ec.orgId = ? AND ec.role = 'survivor'", binds: [scope.orgId] };
  const { results } = await env.DB.prepare(
    `SELECT ec.code, ec.redeemedAt, ec.redeemedBy, u.entitlement, u.guardianEnabled
       FROM enrollment_codes ec LEFT JOIN users u ON u.id = ec.redeemedBy
      WHERE ${where.sql} ORDER BY ec.createdAt DESC LIMIT ?`,
  )
    .bind(...where.binds, LIST_LIMIT)
    .all<{
      code: string; redeemedAt: number | null; redeemedBy: string | null;
      entitlement: string | null; guardianEnabled: number | null;
    }>();
  const rows = results ?? [];
  const userIds = rows.map((r) => r.redeemedBy).filter((id): id is string => !!id);
  if (userIds.length === 0) {
    return rows.map((r) => ({
      code: r.code,
      redeemedAt: r.redeemedAt,
      state: readinessState({ redeemed: false, activated: false, reachableRecipient: false }),
      confirmedContacts: 0,
      activations30d: 0,
    }));
  }

  // Two bounded fan-in queries rather than one per row. `placeholders` is built from the
  // COUNT of ids, never from their values — the ids themselves are always bound.
  const placeholders = userIds.map(() => '?').join(',');
  const since = Date.now() - WINDOW_30D_MS;
  const [contactRows, eventRows] = await Promise.all([
    env.DB.prepare(
      `SELECT c.userId, c.role, c.status, ep.channel
         FROM contacts c JOIN contact_endpoints ep ON ep.contactId = c.id
        WHERE c.userId IN (${placeholders}) AND c.role IN ('contact','guardian')`,
    )
      .bind(...userIds)
      .all<{ userId: string; role: string; status: string | null; channel: string }>(),
    env.DB.prepare(
      `SELECT userId, COUNT(*) AS n FROM events WHERE userId IN (${placeholders}) AND createdAt >= ? AND isTest = 0 GROUP BY userId`,
    )
      .bind(...userIds, since)
      .all<{ userId: string; n: number }>(),
  ]);

  // Readiness is judged by the SAME rule the survivor's own client is judged by:
  // isChannelDeliverable for the channel, the consent gate for the status, and
  // hasReachableRecipient for the verdict. A roster that used a looser rule would tell a
  // coordinator someone is Armed when their own app says they are not.
  const gate = consentGateEnforced(env);
  const byUser = new Map<string, { role: string; deliverable: boolean }[]>();
  const confirmedCount = new Map<string, number>();
  for (const r of contactRows.results ?? []) {
    if (gate && r.status !== 'confirmed') continue;
    const list = byUser.get(r.userId) ?? [];
    list.push({ role: r.role, deliverable: isChannelDeliverable(env, r.channel) });
    byUser.set(r.userId, list);
    if (r.status === 'confirmed' || r.status == null) {
      confirmedCount.set(r.userId, (confirmedCount.get(r.userId) ?? 0) + 1);
    }
  }
  const events = new Map((eventRows.results ?? []).map((r) => [r.userId, Number(r.n)]));

  return rows.map((r) => {
    const uid = r.redeemedBy;
    const reachable = uid
      ? hasReachableRecipient(byUser.get(uid) ?? [], (r.guardianEnabled ?? 1) === 1)
      : false;
    return {
      code: r.code,
      redeemedAt: r.redeemedAt,
      state: readinessState({
        redeemed: !!uid,
        activated: r.entitlement === 'activated',
        reachableRecipient: reachable,
      }),
      confirmedContacts: uid ? (confirmedCount.get(uid) ?? 0) : 0,
      activations30d: uid ? (events.get(uid) ?? 0) : 0,
    };
  });
}

consoleRoutes.get('/roster', requireLevel('admin', 'coordinator'), async (c) => {
  const identity = identityOf(c);
  const visibility = rosterVisibility(identity.level);
  const roster = await loadRoster(c.env, {
    orgId: scopedOrg(c),
    createdBy: visibility === 'own' ? c.get('userId') : undefined,
  });
  return c.json({ scope: visibility, roster }, 200);
});

// =====================================================================
// §3 MAINTENANCE — operator only. Every action a button, every action audited to a
// PERSON, every destructive action dry-run by default.
// =====================================================================

/**
 * System health: D1, R2, the deployed build, PWA↔Worker currency, and migration state.
 *
 * Each probe reports its OWN outcome and a failed probe never fails the panel — a health
 * page that 500s when a dependency is down tells you nothing at the exact moment you
 * need it. "unknown" is never reported as healthy.
 */
consoleRoutes.get('/maintenance/health', requireLevel('operator'), async (c) => {
  const workerBuild = c.env.WORKER_BUILD ?? 'dev';

  const d1 = await (async () => {
    const started = Date.now();
    try {
      const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
      return { ok: true, ms: Date.now() - started, accounts: Number(row?.n ?? 0), detail: null as string | null };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, accounts: null, detail: (err as Error).message };
    }
  })();

  const r2 = await (async () => {
    const started = Date.now();
    if (!c.env.MEDIA) {
      return { ok: false, ms: 0, detail: 'MEDIA binding is not configured' };
    }
    try {
      await c.env.MEDIA.list({ limit: 1 });
      return { ok: true, ms: Date.now() - started, detail: null as string | null };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, detail: (err as Error).message };
    }
  })();

  // Currency: the LIVE PWA build, read from the deployed origin with cache defeated —
  // never a local artifact. Unreachable is a FAILURE, never 'unknown' and never a skip:
  // the whole reason this check exists is that a silent 'unknown' once let production run
  // a two-week-old client.
  const pwa = await (async () => {
    const origin = (c.env.PWA_ORIGIN ?? '').replace(/\/$/, '');
    if (!origin) {
      return { ok: false, build: null as string | null, detail: 'PWA_ORIGIN is not configured' };
    }
    try {
      // Cache-busted URL + no-cache, and the Worker's own cache disabled via cf, so this
      // reads what the edge is serving RIGHT NOW rather than something we fetched earlier.
      const res = await fetch(`${origin}/version.json?ts=${Date.now()}`, {
        headers: { 'cache-control': 'no-cache' },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res.ok) {
        return { ok: false, build: null, detail: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { build?: string };
      return { ok: typeof body.build === 'string', build: body.build ?? null, detail: null as string | null };
    } catch (err) {
      return { ok: false, build: null, detail: `unreachable (${(err as Error).message})` };
    }
  })();

  const migrations = await (async () => {
    try {
      const { results } = await c.env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id ASC').all<{ name: string }>();
      const applied = (results ?? []).map((r) => r.name.replace(/\.sql$/, ''));
      const appliedSet = new Set(applied);
      const pending = MIGRATIONS_AT_BUILD.filter((m) => !appliedSet.has(m));
      return {
        ok: pending.length === 0,
        appliedCount: applied.length,
        latestApplied: applied[applied.length - 1] ?? null,
        expectedCount: MIGRATIONS_AT_BUILD.length,
        pending,
        detail: null as string | null,
      };
    } catch (err) {
      return {
        ok: false,
        appliedCount: null,
        latestApplied: null,
        expectedCount: MIGRATIONS_AT_BUILD.length,
        pending: [] as string[],
        detail: (err as Error).message,
      };
    }
  })();

  const currency = {
    worker: workerBuild,
    pwa: pwa.build,
    // Matched ONLY when both halves proved a build and the builds are identical. A null
    // on either side is a mismatch, not a pass.
    matched: pwa.ok && pwa.build != null && pwa.build === workerBuild,
  };

  return c.json(
    {
      // The panel is healthy only when every probe is. No partial green.
      ok: d1.ok && r2.ok && pwa.ok && migrations.ok && currency.matched,
      checkedAt: Date.now(),
      d1,
      r2,
      currency,
      migrations,
    },
    200,
  );
});

/**
 * R2 orphan purge — DRY RUN BY DEFAULT. The preview and the deletion run the SAME
 * routine with one flag flipped, so the count shown is the count that would be deleted,
 * not a separate estimate that could disagree.
 */
consoleRoutes.post('/maintenance/purge-media', requireLevel('operator'), async (c) => {
  const actor = c.get('userId');
  const body = await c.req
    .json<{ confirm?: boolean; maxObjects?: number }>()
    .catch(() => ({}) as { confirm?: boolean; maxObjects?: number });
  const result = await purgeOrphanedMedia(c.env, {
    confirm: body.confirm === true,
    maxObjects: typeof body.maxObjects === 'number' ? body.maxObjects : undefined,
  });
  await audit(c.env, null, result.dryRun ? 'console.purge_preview' : 'console.purge_media', actor, {
    deleted: result.deleted,
    scanned: result.scanned,
    done: result.done,
  });
  return c.json(result, 200);
});

/**
 * Account deletion — DRY RUN BY DEFAULT, and the cascading one: the R2 bytes go before
 * the index rows that name them. This is the routine written to end the ~10,700 orphaned
 * recordings; using any other delete here would recreate them.
 */
consoleRoutes.post('/maintenance/delete-account', requireLevel('operator'), async (c) => {
  const actor = c.get('userId');
  const body = await c.req
    .json<{ userId?: string; email?: string; confirm?: boolean; reason?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const reason = (body.reason ?? '').trim();
  const target = body.userId?.trim()
    ? await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(body.userId.trim()).first<{ id: string; email: string | null }>()
    : body.email?.trim()
      ? await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(body.email.trim()).first<{ id: string; email: string | null }>()
      : null;
  if (!target) {
    return c.json({ error: 'account_not_found' }, 404);
  }
  // A reason is required only to DELETE. Previewing is how an operator finds out what a
  // deletion would cost, and demanding a justification to look is how people stop looking.
  if (body.confirm === true && !reason) {
    return c.json({ error: 'reason_required', message: 'A reason is required to delete an account — this is irreversible and logged.' }, 400);
  }
  const result = await deleteAccount(c.env, target.id, { confirm: body.confirm === true });
  await audit(c.env, null, result.deleted ? 'console.account_delete' : 'console.account_delete_preview', actor, {
    targetUserId: target.id,
    events: result.events,
    chunks: result.chunks,
    r2Deleted: result.r2Deleted,
    reason: reason || null,
  });
  return c.json({ ...result, userId: target.id, email: target.email }, 200);
});

/**
 * The audit trail for console actions — who did what, when. Operator only. Reads the
 * `console.*` actions only: this is the maintenance log, not a window onto event audit
 * rows (those belong to incidents).
 */
consoleRoutes.get('/maintenance/audit', requireLevel('operator'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.action, a.actorHash, a.timestamp, a.metadataJson,
            (SELECT COALESCE(u.name, u.email) FROM users u WHERE u.id = a.actorHash) AS actorName
       FROM audit_log a
      WHERE a.action LIKE 'console.%' ORDER BY a.timestamp DESC LIMIT ?`,
  )
    .bind(LIST_LIMIT)
    .all<{ action: string; actorHash: string | null; timestamp: number; metadataJson: string | null; actorName: string | null }>();
  return c.json(
    {
      entries: (results ?? []).map((r) => ({
        action: r.action,
        at: r.timestamp,
        actorUserId: r.actorHash,
        actor: r.actorName ?? r.actorHash,
        metadata: r.metadataJson,
      })),
    },
    200,
  );
});
