import type { MiddlewareHandler } from 'hono';
import { verifyRequest } from '@blackbox/shared';
import type { Env, Vars } from './types';

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
