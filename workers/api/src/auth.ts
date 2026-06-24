import type { MiddlewareHandler } from 'hono';
import { verifyRequest } from '@blackbox/shared';
import { verifySession } from './lib/session';
import type { Env, Vars } from './types';

/** HMAC key for session + invite tokens. Falls back to the magic-link key. */
export function sessionSecret(env: Env): string | null {
  return env.SESSION_SECRET ?? env.MAGIC_LINK_SECRET ?? null;
}

/** Require a valid Bearer session token; sets `userId` on success. */
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
  const u = await c.env.DB.prepare('SELECT sessionsValidFrom FROM users WHERE id = ?')
    .bind(session.userId)
    .first<{ sessionsValidFrom: number | null }>();
  if (u?.sessionsValidFrom != null && session.issuedAt < u.sessionsValidFrom) {
    return c.json({ error: 'session_expired' }, 401);
  }
  c.set('userId', session.userId);
  await next();
  return undefined;
};

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
