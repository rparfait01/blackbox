import type { MiddlewareHandler } from 'hono';
import { verifyRequest } from '@blackbox/shared';
import { verifySession } from './lib/session';
import { noteSessionFormat, sessionFormat, tokenHash } from './lib/session-rotation';
import { roleSatisfies } from './lib/org';
import type { Env, Vars } from './types';

/** HMAC key for session + invite tokens. Falls back to the magic-link key. */
export function sessionSecret(env: Env): string | null {
  return env.SESSION_SECRET ?? env.MAGIC_LINK_SECRET ?? null;
}

/** Require a valid Bearer session token; sets `userId` (and `orgId`) on success. */
export const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (
  c,
  next,
) => {
  const secret = sessionSecret(c.env);
  const token = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const session = secret ? await verifySession(secret, token) : null;
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // §D: a password reset bumps users.sessionsValidFrom; any session minted before
  // that instant is rejected, so old sessions are invalidated on reset.
  // Brief 23: the SAME lookup resolves the account's orgId (server truth, never from
  // the token — the session token shape is load-bearing and must not be extended).
  //
  // Brief 42 §C — the per-token revocation check rides in the SAME statement. It is a correlated
  // subquery rather than a second round trip, because this middleware gates every authenticated
  // route and adding a second read here would tax the whole product to catch a rare condition.
  const u = await c.env.DB.prepare(
    `SELECT sessionsValidFrom, orgId, lastSessionFormat,
            (SELECT 1 FROM revoked_sessions WHERE tokenHash = ?) AS revoked
     FROM users WHERE id = ?`,
  )
    .bind(await tokenHash(token), session.userId)
    .first<{ sessionsValidFrom: number | null; orgId: string | null; lastSessionFormat: string | null; revoked: number | null }>();
  if (u?.sessionsValidFrom != null && session.issuedAt < u.sessionsValidFrom) {
    return c.json({ error: 'session_expired' }, 401);
  }
  if (u?.revoked === 1) {
    // §C — the presented token was rotated away. Only THIS token; other devices are untouched.
    return c.json({ error: 'session_rotated' }, 401);
  }
  c.set('userId', session.userId);
  c.set('orgId', u?.orgId ?? null);
  // §C — record the format actually presented, and only when it changed. For a given account this
  // writes once, on the rotation that upgrades it, so the ordinary request pays nothing.
  const format = sessionFormat(token);
  if (format && format !== u?.lastSessionFormat) {
    c.executionCtx.waitUntil(noteSessionFormat(c.env, session.userId, format, u?.lastSessionFormat ?? null));
  }
  await next();
  return undefined;
};

/**
 * Brief 23 — gate the org portal (/v1/org/*). MUST run after requireSession. Requires
 * an ACTIVE org_members (STAFF) row meeting the role, and sets `orgId` + `orgRole`
 * from that membership — server truth, never the client. Every /v1/org/* query then
 * scopes by `c.get('orgId')`, so a coordinator can only ever reach their OWN org.
 * Least privilege: `admin` satisfies any requirement; `coordinator` satisfies only
 * coordinator-level. A revoked membership loses access immediately (status filter).
 */
export function requireOrgRole(
  required: 'admin' | 'coordinator',
): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const userId = c.get('userId');
    // One active staff membership per account for the pilot (UNIQUE(orgId,userId));
    // the first active row is the member's org.
    const member = await c.env.DB.prepare(
      "SELECT orgId, role FROM org_members WHERE userId = ? AND status = 'active' LIMIT 1",
    )
      .bind(userId)
      .first<{ orgId: string; role: 'admin' | 'coordinator' }>();
    if (!member) {
      return c.json({ error: 'not_an_org_member' }, 403);
    }
    if (!roleSatisfies(required, member.role)) {
      return c.json({ error: 'admin_required' }, 403);
    }
    c.set('orgId', member.orgId);
    c.set('orgRole', member.role);
    await next();
    return undefined;
  };
}

/**
 * Per-event HMAC authentication. The event id comes from the path; its secret
 * is looked up in D1 and used to verify the request signature over
 * `METHOD\npathname\ntimestamp\nsha256(body)`. The signed body bytes are read
 * from a clone so the route handler can still read the original.
 */
export const hmacAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const eventId = c.req.param('id');
  const headerEventId = c.req.header('X-Event-Id');
  const timestamp = Number(c.req.header('X-Timestamp'));
  const signature = c.req.header('X-Signature');

  if (!eventId || headerEventId !== eventId || !signature || !Number.isFinite(timestamp)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const row = await c.env.DB.prepare('SELECT hmacSecret FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ hmacSecret: string }>();
  if (!row) {
    return c.json({ error: 'unknown event' }, 404);
  }

  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const valid = await verifyRequest({
    secret: row.hmacSecret,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    timestamp,
    body,
    signature,
  });
  if (!valid) {
    return c.json({ error: 'bad signature' }, 401);
  }

  c.set('eventSecret', row.hmacSecret);
  await next();
  return undefined;
};
