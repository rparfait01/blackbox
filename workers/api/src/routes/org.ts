/**
 * Org portal routes (Brief 23). The separate org surface — coordinators/admins sign
 * in with the SAME passwordless session as everyone else, then reach only THEIR org.
 * requireSession sets userId+orgId; requireOrgRole re-derives orgId from the STAFF
 * membership row and gates the role. Every handler scopes strictly by c.get('orgId'),
 * so there is no route by which one org reaches another. §3 adds code issue/revoke;
 * §5 adds the read surfaces (survivors / events / license) and seat management.
 */
import { Hono } from 'hono';

import { requireOrgRole, requireSession } from '../auth';
import { createEnrollmentCode, getActiveLicense, getOrg } from '../lib/org';
import { leaveOrg } from '../lib/enrollment';
import { audit } from '../lib/audit';
import type { Env, Vars } from '../types';

export const orgRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// A valid account session is required for the whole surface; each route then adds its
// role gate. A survivor with no staff membership hits 403 (not_an_org_member).
orgRoutes.use('*', requireSession);

// Who is the caller in the org world? Session-only (NO role gate) so the portal can
// distinguish "signed in but not staff" from coordinator/admin. Returns the active
// staff membership or null — never anyone else's.
orgRoutes.get('/me', async (c) => {
  const member = await c.env.DB.prepare(
    "SELECT m.orgId, m.role, o.name AS orgName, o.lane FROM org_members m JOIN organizations o ON o.id = m.orgId WHERE m.userId = ? AND m.status = 'active' LIMIT 1",
  )
    .bind(c.get('userId'))
    .first<{ orgId: string; role: 'admin' | 'coordinator'; orgName: string; lane: string }>();
  return c.json({ member: member ?? null }, 200);
});

// §3 — issue an enrollment code, scoped to the issuer's OWN org (orgId from the
// membership, never the client). A coordinator may mint SURVIVOR codes; minting a
// staff (coordinator/admin) code is an admin action — least privilege.
orgRoutes.post('/codes', requireOrgRole('coordinator'), async (c) => {
  const orgId = c.get('orgId')!;
  const actorRole = c.get('orgRole')!;
  const body = await c.req
    .json<{ role?: string; maxUses?: number; expiresInHours?: number }>()
    .catch(() => ({}) as { role?: string; maxUses?: number; expiresInHours?: number });
  const requested = body.role === 'coordinator' || body.role === 'admin' ? body.role : 'survivor';
  if (requested !== 'survivor' && actorRole !== 'admin') {
    return c.json({ error: 'admin_required_for_staff_codes' }, 403);
  }
  const expiresAt =
    typeof body.expiresInHours === 'number' && body.expiresInHours > 0
      ? Date.now() + body.expiresInHours * 3_600_000
      : null;
  const maxUses = typeof body.maxUses === 'number' && body.maxUses > 0 ? Math.floor(body.maxUses) : 1;
  const codeRow = await createEnrollmentCode(c.env, {
    orgId,
    role: requested,
    maxUses,
    expiresAt,
    createdBy: c.get('userId'),
  });
  await audit(c.env, null, 'org.code_issue', c.get('userId'), { orgId, role: requested, maxUses });
  return c.json({ code: codeRow.code, role: requested, maxUses, expiresAt }, 201);
});

// §3 — revoke a code, but ONLY one belonging to the coordinator's own org (the
// orgId predicate is the isolation boundary — a code from another org is not found).
orgRoutes.post('/codes/:code/revoke', requireOrgRole('coordinator'), async (c) => {
  const orgId = c.get('orgId')!;
  const code = c.req.param('code');
  const res = await c.env.DB.prepare('UPDATE enrollment_codes SET revoked = 1 WHERE code = ? AND orgId = ?')
    .bind(code, orgId)
    .run();
  if (res.meta.changes !== 1) {
    return c.json({ error: 'code_not_found' }, 404);
  }
  await audit(c.env, null, 'org.code_revoke', c.get('userId'), { orgId, code });
  return c.json({ revoked: true }, 200);
});

// §5 Track — this org's enrolled accounts + setup status. Every row is scoped by the
// caller's OWN orgId (from the membership), so no account from another org can appear.
orgRoutes.get('/survivors', requireOrgRole('coordinator'), async (c) => {
  const orgId = c.get('orgId')!;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.createdAt,
       (SELECT COUNT(*) FROM contacts ct WHERE ct.userId = u.id) AS contactCount,
       (SELECT COUNT(*) FROM events e WHERE e.userId = u.id AND e.status = 'active') AS activeEvents,
       (SELECT role FROM org_members m WHERE m.userId = u.id AND m.orgId = u.orgId AND m.status = 'active') AS staffRole
     FROM users u WHERE u.orgId = ? ORDER BY u.createdAt DESC`,
  )
    .bind(orgId)
    .all<{ id: string; name: string | null; createdAt: number; contactCount: number; activeEvents: number; staffRole: string | null }>();
  const survivors = results.map((r) => ({
    userId: r.id,
    name: r.name,
    enrolledAt: r.createdAt,
    setupComplete: Number(r.contactCount) > 0,
    contactsConfigured: Number(r.contactCount),
    activeEvent: Number(r.activeEvents) > 0,
    role: r.staffRole ?? 'survivor',
  }));
  return c.json({ survivors }, 200);
});

// §5 Correlate — this org's active events → survivor. org-scoped by the stamped
// events.orgId; an event from another org is never returned.
orgRoutes.get('/events', requireOrgRole('coordinator'), async (c) => {
  const orgId = c.get('orgId')!;
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.createdAt, e.status, e.userId, e.cascadeStep, u.name AS survivorName
     FROM events e LEFT JOIN users u ON u.id = e.userId
     WHERE e.orgId = ? AND e.status = 'active' ORDER BY e.createdAt DESC`,
  )
    .bind(orgId)
    .all<{ id: string; createdAt: number; status: string; userId: string | null; cascadeStep: number; survivorName: string | null }>();
  return c.json({ events: results }, 200);
});

// §5 Correlate detail — one event's history, ONLY if it belongs to this org. The
// `AND e.orgId = ?` predicate IS the isolation boundary: another org's event 404s.
orgRoutes.get('/events/:id', requireOrgRole('coordinator'), async (c) => {
  const orgId = c.get('orgId')!;
  const ev = await c.env.DB.prepare(
    `SELECT e.id, e.createdAt, e.status, e.closedAt, e.closedBy, e.userId, u.name AS survivorName
     FROM events e LEFT JOIN users u ON u.id = e.userId WHERE e.id = ? AND e.orgId = ?`,
  )
    .bind(c.req.param('id'), orgId)
    .first();
  if (!ev) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ event: ev }, 200);
});

// §5 License view — admin, read-only.
orgRoutes.get('/license', requireOrgRole('admin'), async (c) => {
  const orgId = c.get('orgId')!;
  const [org, license] = await Promise.all([getOrg(c.env, orgId), getActiveLicense(c.env, orgId)]);
  return c.json(
    { org: org ? { name: org.name, lane: org.lane, status: org.status } : null, license },
    200,
  );
});

// §5 Seats — admin adjusts the ceiling. Cannot drop below seats already in use.
orgRoutes.post('/seats', requireOrgRole('admin'), async (c) => {
  const orgId = c.get('orgId')!;
  const body = await c.req.json<{ seatsTotal?: number }>().catch(() => ({}) as { seatsTotal?: number });
  const seatsTotal = typeof body.seatsTotal === 'number' ? Math.max(0, Math.floor(body.seatsTotal)) : null;
  if (seatsTotal == null) {
    return c.json({ error: 'seatsTotal_required' }, 400);
  }
  const license = await getActiveLicense(c.env, orgId);
  if (!license) {
    return c.json({ error: 'no_license' }, 404);
  }
  if (seatsTotal < license.seatsUsed) {
    return c.json(
      { error: 'below_seats_in_use', message: `Cannot set fewer seats (${seatsTotal}) than are in use (${license.seatsUsed}). Remove enrolled survivors first.` },
      409,
    );
  }
  await c.env.DB.prepare('UPDATE org_licenses SET seatsTotal = ? WHERE id = ?')
    .bind(seatsTotal, license.id)
    .run();
  await audit(c.env, null, 'org.seats_set', c.get('userId'), { orgId, seatsTotal });
  return c.json({ seatsTotal, seatsUsed: license.seatsUsed }, 200);
});

// §5 Remove a seat — admin unenrolls an account in THIS org; access is revoked
// immediately (users.orgId cleared → next requireSession sees no org; staff
// membership revoked; the survivor seat is freed). Scoped: only an account in the
// caller's own org can be removed.
orgRoutes.post('/survivors/:userId/remove', requireOrgRole('admin'), async (c) => {
  const orgId = c.get('orgId')!;
  const targetId = c.req.param('userId');
  const target = await c.env.DB.prepare('SELECT orgId FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ orgId: string | null }>();
  if (!target || target.orgId !== orgId) {
    return c.json({ error: 'not_found' }, 404);
  }
  await leaveOrg(c.env, targetId);
  await audit(c.env, null, 'org.seat_remove', c.get('userId'), { orgId, targetId });
  return c.json({ removed: true }, 200);
});
