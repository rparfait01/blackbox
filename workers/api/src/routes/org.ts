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
import { createEnrollmentCode } from '../lib/org';
import { audit } from '../lib/audit';
import type { Env, Vars } from '../types';

export const orgRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// A valid account session is required for the whole surface; each route then adds its
// role gate. A survivor with no staff membership hits 403 (not_an_org_member).
orgRoutes.use('*', requireSession);

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
