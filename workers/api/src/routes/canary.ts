/**
 * Deploy-canary control surface (Brief 35 §C). Mounted under `/v1/admin/canary`, so it
 * inherits the admin gate in index.ts — ADMIN_TOKEN or an operator session, nothing
 * else. Every route here is operator tooling: none of it is reachable from the PWA, and
 * none of it is reachable by a survivor's session.
 *
 * WHY THESE ARE ROUTES AND NOT A SCRIPT WITH DATABASE ACCESS. The gate has to prove that
 * the DEPLOYED WORKER can do the whole round trip on the origin just published. A script
 * talking to D1 directly would prove that D1 is reachable from the operator's laptop,
 * which is not the thing that broke. So provisioning, status and purge all go through
 * the live Worker, over the same origin the PWA was built against.
 */

import { Hono } from 'hono';
import {
  CANARY_EMAIL,
  CANARY_TTL_MS,
  canaryEnvironmentReport,
  provisionCanary,
  purgeCanaryEvents,
} from '../lib/canary';
import { audit } from '../lib/audit';
import { mintSession } from '../lib/session';
import { sessionSecret } from '../auth';
import type { Env, Vars } from '../types';

export const canaryRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Provision the canary account + its reserved-address contact, and hand back a session
 * for it so the gate can drive a REAL trigger through the ordinary authenticated path.
 *
 * Handing out a session is safe precisely because of what this account is: its address
 * is RFC 2606 reserved, its contact endpoints are reserved, it holds no data, and every
 * event it opens is suppressed at the router and purged at the end of the run. It is
 * also already behind the admin gate — anyone who can call this can do far more.
 */
canaryRoutes.post('/provision', async (c) => {
  const secret = sessionSecret(c.env);
  if (!secret) {
    return c.json({ error: 'session_secret_unset', message: 'SESSION_SECRET/MAGIC_LINK_SECRET is not configured' }, 500);
  }
  // Report WHY provisioning failed. A bare 500 from a deploy gate is the same disease
  // this brief exists to cure: the operator learns that something is wrong and nothing
  // about what. Admin-gated, and the messages here name constants and schema, not secrets.
  let account;
  try {
    account = await provisionCanary(c.env);
  } catch (error) {
    return c.json({ error: 'provision_failed', detail: String(error) }, 500);
  }
  const sessionToken = await mintSession(secret, account.userId);
  await audit(c.env, null, 'canary.provision', c.get('operatorUserId') ?? null, { email: CANARY_EMAIL });
  return c.json(
    {
      ok: true,
      userId: account.userId,
      email: account.email,
      contactId: account.contactId,
      sessionToken,
      ttlMs: CANARY_TTL_MS,
    },
    200,
  );
});

/**
 * Presence-and-shape of the bindings and secrets the alert path needs. §C is explicit:
 * the gate verifies that required secrets EXIST, never what they contain. Nothing in
 * this response can be turned back into a credential.
 */
canaryRoutes.get('/status', async (c) => {
  const counts = await c.env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM users WHERE isCanary = 1) AS accounts, (SELECT COUNT(*) FROM events WHERE isTest = 1) AS events',
  ).first<{ accounts: number; events: number }>();
  return c.json(
    {
      ok: true,
      environment: canaryEnvironmentReport(c.env),
      canaryAccounts: Number(counts?.accounts ?? 0),
      canaryEvents: Number(counts?.events ?? 0),
    },
    200,
  );
});

/**
 * Explicit end-of-run purge. Returns `remaining`, which the gate asserts is 0 — "the
 * purge did not confirm" is a deploy failure (§C), not a warning, because a canary event
 * left behind is a fake activation sitting in the same table real ones live in.
 */
canaryRoutes.post('/purge', async (c) => {
  const result = await purgeCanaryEvents(c.env);
  await audit(c.env, null, 'canary.purge', c.get('operatorUserId') ?? null, {
    events: result.events,
    r2Deleted: result.r2Deleted,
    remaining: result.remaining,
  });
  return c.json({ ok: result.purged, ...result }, result.purged ? 200 : 500);
});
