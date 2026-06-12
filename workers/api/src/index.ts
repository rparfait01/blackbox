import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { hmacSha256Hex, randomHex } from '@blackbox/shared';
import { hmacAuth, sessionSecret } from './auth';
import { audit } from './lib/audit';
import { attemptStandDown } from './lib/standdown';
import { appendToChain, hashBytes } from './lib/integrity';
import { qrSvg } from './lib/qr';
import {
  getVerifiedRecipient,
  logRecipientAction,
  registerRecipient,
  verifyRecipient,
} from './lib/recipients';
import { acknowledgeCustody, exportPackage } from './lib/custody';
import { bumpTrust, listTrust } from './lib/trust';
import { renderRecipientRegistration } from './dashboard/recipient-page';
import { scheduled } from './scheduled';
import { getContactForEvent, listContacts, listFollows, upsertContact } from './lib/contacts';
import { notifyActivation, notifyEscalation } from './lib/notify';
import { mintMagicToken, mintRoleToken, verifyTokenRole } from './lib/magic-link';
import { getCookie, setCookie } from 'hono/cookie';
import { verifySession } from './lib/session';
import { getContactState } from './lib/contact-state';
import { renderDashboardPage, renderNotifiedPage, renderTokenPage } from './dashboard/page';
import { audioStream, locationStream } from './routes/contact-streams';
import { dispatch } from './channels/router';
import { handleLineWebhook } from './routes/line-webhook';
import { authRoutes } from './routes/auth';
import { guardianRoutes } from './routes/guardians';
import { userRoutes } from './routes/user';
import type { Env, Vars } from './types';

/**
 * BLACK BOX API Worker. Stores activation media + metadata (classification stays
 * on-device) and, in W6, delivers the LINE notification that is the real
 * acknowledgment loop. Logs only requestId / endpoint / status / latency; never
 * payload contents, secrets, or contact identifiers.
 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

function allowedOrigins(env: Env): string[] {
  return (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** The event's stored tz offset (UTC canonical), for stamping child records. */
async function eventTzOffset(env: Env, eventId: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT tzOffsetMinutes FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ tzOffsetMinutes: number | null }>();
  return row?.tzOffsetMinutes ?? null;
}

// CORS (also handles preflight for every endpoint).
app.use('*', (c, next) =>
  cors({
    origin: (origin) => {
      const allowed = allowedOrigins(c.env);
      if (origin && allowed.includes(origin)) {
        return origin;
      }
      return allowed[0] ?? '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Event-Id',
      'X-Timestamp',
      'X-Signature',
      'X-Mime-Type',
    ],
    maxAge: 86400,
  })(c, next),
);

// Structured request logging — no payload contents.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  await next();
  console.log(
    JSON.stringify({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - start,
    }),
  );
});

app.onError((error, c) => {
  console.log(JSON.stringify({ level: 'error', message: error.message }));
  return c.json({ error: 'internal' }, 500);
});

// --- Health (no auth) ---
app.get('/v1/health', async (c) => {
  let d1 = false;
  let r2 = false;
  try {
    await c.env.DB.prepare('SELECT 1').first();
    d1 = true;
  } catch {
    d1 = false;
  }
  try {
    // head() of a missing key returns null (does not throw) — proves the binding.
    await c.env.MEDIA.head('___healthcheck___');
    r2 = true;
  } catch {
    r2 = false;
  }
  return c.json({ status: d1 && r2 ? 'ok' : 'degraded', d1, r2 }, 200);
});

// --- Create event (mints the per-event secret). Optional Bearer session ties
// the event to a user account; legacy clients still send userHash. ---
interface OpenEventBody {
  userHash?: string;
  source?: string;
  startTime?: number;
  locale?: string;
  tzOffsetMinutes?: number;
  location?: { lat?: number; lon?: number; accuracy?: number } | null;
}

app.post('/v1/events', async (c) => {
  const body = await c.req.json<OpenEventBody>().catch(() => ({}) as OpenEventBody);
  const eventId = crypto.randomUUID();
  const hmacSecret = randomHex(32);
  const createdAt = Date.now();
  const userHash = body.userHash ?? '';
  const tzOffsetMinutes = typeof body.tzOffsetMinutes === 'number' ? body.tzOffsetMinutes : null;

  // Resolve userId from an optional session token (does not gate event creation).
  const secret = sessionSecret(c.env);
  const token = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const session = secret && token ? await verifySession(secret, token) : null;
  const userId = session?.userId ?? null;

  // lastHeartbeatAt seeds to createdAt so a brand-new event is never instantly
  // flagged "dark" before the first heartbeat lands.
  await c.env.DB.prepare(
    'INSERT INTO events (id, createdAt, status, userHash, userId, hmacSecret, source, locale, tzOffsetMinutes, lastHeartbeatAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      eventId,
      createdAt,
      'active',
      userHash,
      userId,
      hmacSecret,
      body.source ?? null,
      body.locale ?? null,
      tzOffsetMinutes,
      createdAt,
    )
    .run();
  // Seed the first location (sent in the open body) so the very first alert can
  // already carry a position.
  if (body.location && typeof body.location.lat === 'number' && typeof body.location.lon === 'number') {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO locations_index (eventId, timestamp, lat, lon, accuracyM, speed) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(eventId, createdAt, body.location.lat, body.location.lon, body.location.accuracy ?? null, null)
      .run();
  }
  await audit(c.env, eventId, 'event.create', userHash || userId, { source: body.source });

  // Push the activation alert to the contact off the response path (records
  // events.notifiedAt on success). Nothing is signalled back to the user's
  // phone; this never blocks the 201 below.
  const workerOrigin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(notifyActivation(c.env, eventId, workerOrigin));

  return c.json({ eventId, hmacSecret, createdAt }, 201);
});

// --- Mounted route groups (auth, guardians, user/settings) ---
app.route('/v1/auth', authRoutes);
app.route('/v1/guardians', guardianRoutes);
app.route('/v1/me', userRoutes);

// --- Admin (pilot-only; Bearer ADMIN_TOKEN). Onboarding moves to W9. ---
app.use('/v1/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const provided = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!expected || provided !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
  return undefined;
});

interface AdminContactBody {
  userHash?: string;
  displayName?: string;
  // New shape: one or more endpoints tried in priority order.
  endpoints?: Array<{ channel?: string; channelIdentifier?: string; priority?: number }>;
  // Legacy shape (back-compat): a single LINE endpoint.
  channel?: string;
  channelUserId?: string;
}

app.post('/v1/admin/contacts', async (c) => {
  const body = await c.req.json<AdminContactBody>().catch(() => ({}) as AdminContactBody);
  if (!body.userHash || !body.displayName) {
    return c.json({ error: 'userHash and displayName are required' }, 400);
  }

  // Accept the new endpoints[] shape; fall back to the legacy single-channel
  // shape (channel + channelUserId) as one endpoint at priority 1.
  let endpoints: Array<{ channel: string; channelIdentifier: string; priority: number }> = [];
  if (Array.isArray(body.endpoints) && body.endpoints.length > 0) {
    endpoints = body.endpoints
      .filter((e) => e.channel && e.channelIdentifier)
      .map((e, i) => ({
        channel: e.channel as string,
        channelIdentifier: e.channelIdentifier as string,
        priority: typeof e.priority === 'number' ? e.priority : i + 1,
      }));
  } else if (body.channelUserId) {
    endpoints = [
      { channel: body.channel ?? 'line', channelIdentifier: body.channelUserId, priority: 1 },
    ];
  }
  if (endpoints.length === 0) {
    return c.json({ error: 'at least one endpoint (channel + channelIdentifier) is required' }, 400);
  }

  const { contact, endpointCount } = await upsertContact(c.env, {
    userHash: body.userHash,
    displayName: body.displayName,
    endpoints,
  });
  await audit(c.env, null, 'admin.contact_upsert', body.userHash, { endpointCount });
  return c.json({ id: contact.id, userHash: contact.userHash, endpointCount }, 201);
});

app.get('/v1/admin/contacts', async (c) => {
  return c.json({ contacts: await listContacts(c.env) }, 200);
});

app.get('/v1/admin/line-follows', async (c) => {
  return c.json({ follows: await listFollows(c.env) }, 200);
});

// --- Trust records (C5) + investigations (C4), operator-facing ---
app.get('/v1/admin/trust', async (c) => {
  return c.json({ trust: await listTrust(c.env) }, 200);
});

app.get('/v1/admin/investigations', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, eventId, recipientId, kind, detail, status, openedAt, resolvedAt, resolution FROM investigations ORDER BY openedAt DESC',
  ).all();
  return c.json({ investigations: results ?? [] }, 200);
});

app.post('/v1/admin/investigations/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req
    .json<{ resolution?: string; cooperated?: boolean }>()
    .catch(() => ({}) as { resolution?: string; cooperated?: boolean });
  const inv = await c.env.DB.prepare(
    'SELECT id, recipientId, status FROM investigations WHERE id = ?',
  )
    .bind(id)
    .first<{ id: string; recipientId: string | null; status: string }>();
  if (!inv) {
    return c.json({ error: 'not found' }, 404);
  }
  await c.env.DB.prepare(
    "UPDATE investigations SET status = 'resolved', resolvedAt = ?, resolution = ? WHERE id = ?",
  )
    .bind(Date.now(), body.resolution ?? null, id)
    .run();
  // Track cooperation against the recipient/agency trust record.
  if (inv.recipientId) {
    const recipient = await c.env.DB.prepare('SELECT agency FROM recipients WHERE id = ?')
      .bind(inv.recipientId)
      .first<{ agency: string }>();
    await bumpTrust(
      c.env,
      [
        { type: 'recipient', id: inv.recipientId },
        ...(recipient ? [{ type: 'agency' as const, id: recipient.agency }] : []),
      ],
      { investigationsTotal: 1, investigationsCooperated: body.cooperated ? 1 : 0 },
    );
  }
  return c.json({ ok: true }, 200);
});

// --- LINE webhook (no HMAC auth; verifies its own x-line-signature) ---
app.post('/v1/webhooks/line', handleLineWebhook);

// --- Contact magic-link view (no login; the signed token is the auth) ---
async function requireMagicToken(c: AppContext): Promise<boolean> {
  const secret = c.env.MAGIC_LINK_SECRET;
  if (!secret) {
    return false;
  }
  const eventId = c.req.param('id') ?? '';
  const token = c.req.query('t') ?? '';
  // Accept any valid role token (guardian/coordinator/notified/dispatch) so the
  // dashboard sub-routes work on both the guardian and authority paths.
  const { verdict } = await verifyTokenRole(secret, eventId, token);
  return verdict === 'ok';
}

// The full dashboard HTML page (loud, contact-facing). Token verdict drives a
// friendly expired/invalid page instead of a bare 401 body.
app.get('/c/:id', async (c) => {
  const secret = c.env.MAGIC_LINK_SECRET;
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const { verdict, role } = secret
    ? await verifyTokenRole(secret, eventId, token)
    : ({ verdict: 'invalid' as const, role: 'guardian' as const });
  if (verdict !== 'ok') {
    return c.html(renderTokenPage(verdict === 'expired' ? 'expired' : 'invalid'), 401);
  }
  const workerOrigin = new URL(c.req.url).origin;

  // AUTHORITY (dispatch) path — the C1 verify-identity gate applies HERE ONLY
  // (Fix Brief 3 R3). Until the holder registers + verifies, serve the gate;
  // then the CAD dispatch view with evidence + export.
  if (role === 'dispatch') {
    const recipient = await getVerifiedRecipient(c.env, eventId, token);
    if (!recipient) {
      return c.html(renderRecipientRegistration({ eventId, token, base: workerOrigin }));
    }
    const state = await getContactState(c.env, eventId);
    if (!state) {
      return c.html(renderTokenPage('invalid'), 404);
    }
    await logRecipientAction(c.env, recipient.id, eventId, 'view');
    return c.html(
      renderDashboardPage({ eventId, token, base: workerOrigin, state, recipient, role: 'dispatch' }),
    );
  }

  // GUARDIAN path (Fix Brief 3 R1) — the live view opens IMMEDIATELY, no identity
  // form. Identity here is the pre-registered contact binding from onboarding (a
  // known contact). The first opener claims coordinator; others get notified.
  const state = await getContactState(c.env, eventId);
  if (!state) {
    return c.html(renderTokenPage('invalid'), 404);
  }
  const newKey = randomHex(16);
  const claim = await c.env.DB.prepare(
    'UPDATE events SET coordinatorClaimedAt = ?, coordinatorKey = ? WHERE id = ? AND coordinatorClaimedAt IS NULL',
  )
    .bind(Date.now(), newKey, eventId)
    .run();
  let isCoordinator: boolean;
  if (claim.meta.changes === 1) {
    isCoordinator = true;
    // Path '/' so the cookie is also sent on the /v1/c/:id/* API calls (e.g.
    // dispatch-link, standdown) — not just the /c/:id page (Fix Brief 4 G1).
    setCookie(c, 'bbcoord', newKey, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24,
    });
  } else {
    const row = await c.env.DB.prepare('SELECT coordinatorKey FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ coordinatorKey: string | null }>();
    const cookieKey = getCookie(c, 'bbcoord');
    isCoordinator = !!cookieKey && !!row?.coordinatorKey && cookieKey === row.coordinatorKey;
  }
  await audit(c.env, eventId, isCoordinator ? 'coordinator_view' : 'notified_view', null, null);
  if (isCoordinator) {
    return c.html(
      renderDashboardPage({ eventId, token, base: workerOrigin, state, role: 'coordinator' }),
    );
  }
  return c.html(renderNotifiedPage({ eventId, base: workerOrigin, state }));
});

// Coordinator-only guard for the live guardian path (Fix Brief 3): a valid
// guardian magic token PLUS the bbcoord cookie matching the claimed key.
async function requireCoordinator(c: AppContext, eventId: string): Promise<boolean> {
  if (!(await requireMagicToken(c))) {
    return false;
  }
  const row = await c.env.DB.prepare('SELECT coordinatorKey FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ coordinatorKey: string | null }>();
  const cookieKey = getCookie(c, 'bbcoord');
  return !!cookieKey && !!row?.coordinatorKey && cookieKey === row.coordinatorKey;
}

// "Share with authorities" → mint a dispatch (authority) token (Fix Brief 3 R3).
// The resulting link hits the C1 verify-identity gate before any evidence.
app.get('/v1/c/:id/dispatch-link', async (c) => {
  const eventId = c.req.param('id');
  if (!(await requireCoordinator(c, eventId)) || !c.env.MAGIC_LINK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const token = await mintRoleToken(c.env.MAGIC_LINK_SECRET, eventId, 'dispatch');
  const origin = new URL(c.req.url).origin;
  const url = `${origin}/c/${eventId}?t=${token}`;
  await audit(c.env, eventId, 'dispatch_link_minted', null, null);
  return c.json({ url, qr: qrSvg(url) }, 200);
});

// Coordinator stand-down — requires the user's lock code, server-verified
// (Fix Brief 1 #4 semantics on the coordinator path, Fix Brief 3 R2).
app.post('/v1/c/:id/standdown', async (c) => {
  const eventId = c.req.param('id');
  if (!(await requireCoordinator(c, eventId))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const origin = new URL(c.req.url).origin;
  const outcome = await attemptStandDown(
    c.env,
    eventId,
    body.code ?? '',
    origin,
    'coordinator_lock_code',
  );
  switch (outcome) {
    case 'not_found':
      return c.json({ error: 'not found' }, 404);
    case 'already_closed':
    case 'closed':
      return c.json({ ok: true, closed: true }, 200);
    case 'duress':
      return c.json({ ok: true, closed: false, duress: true }, 200);
    case 'no_lock_code':
      return c.json({ error: 'no_verifiable_lock_code' }, 409);
    default:
      return c.json({ error: 'invalid_code' }, 403);
  }
});

// --- Recipient identity (C1): register + verify before evidence renders ---
app.post('/v1/c/:id/recipient/register', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const body = await c.req
    .json<{ fullName?: string; agency?: string; roleRef?: string; contactType?: string; contactValue?: string; scope?: string }>()
    .catch(() => ({}) as Record<string, string>);
  const result = await registerRecipient(c.env, eventId, token, {
    fullName: body.fullName ?? '',
    agency: body.agency ?? '',
    roleRef: body.roleRef,
    contactType: 'email',
    contactValue: body.contactValue ?? '',
    scope: body.scope === 'export' ? 'export' : 'dispatch',
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400);
  }
  return c.json({ ok: true, recipientId: result.recipientId, expiresAt: result.expiresAt }, 200);
});

app.post('/v1/c/:id/recipient/verify', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const result = await verifyRecipient(c.env, eventId, token, body.code ?? '');
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 400);
  }
  return c.json({ ok: true, recipientId: result.recipientId }, 200);
});

// --- Export = custody transfer + sealed vault (C3). Requires a verified
// recipient identity bound to this token; the export is logged + sealed. ---
app.get('/v1/c/:id/export', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const recipient = await getVerifiedRecipient(c.env, eventId, token);
  if (!recipient) {
    return c.json({ error: 'identity not verified' }, 403);
  }
  const workerOrigin = new URL(c.req.url).origin;
  const result = await exportPackage(c.env, eventId, workerOrigin, recipient.id);
  if (!result) {
    return c.json({ error: 'not found' }, 404);
  }
  // Hand the recipient their verifiable working copy (the signed manifest), with
  // the custody id + package hash so they can acknowledge custody.
  return c.json(
    {
      custodyId: result.custodyId,
      packageHash: result.packageHash,
      vaultKey: result.vaultKey,
      manifest: result.manifest,
    },
    200,
    { 'Content-Disposition': `attachment; filename="blackbox-${eventId}-manifest.json"` },
  );
});

app.post('/v1/c/:id/custody/:custodyId/ack', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const recipient = await getVerifiedRecipient(c.env, eventId, token);
  if (!recipient) {
    return c.json({ error: 'identity not verified' }, 403);
  }
  const ok = await acknowledgeCustody(c.env, c.req.param('custodyId'), recipient.id);
  if (!ok) {
    return c.json({ error: 'not found' }, 404);
  }
  await bumpTrust(
    c.env,
    [
      { type: 'recipient', id: recipient.id },
      { type: 'agency', id: recipient.agency },
    ],
    { custodyAcknowledged: true },
  );
  await logRecipientAction(c.env, recipient.id, eventId, 'custody_ack', c.req.param('custodyId'));
  return c.json({ ok: true }, 200);
});

app.get('/v1/c/:id/state', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const state = await getContactState(c.env, c.req.param('id'));
  if (!state) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(state, 200);
});

/** Stream a single R2 object as the response body. */
async function streamChunk(c: AppContext, r2Key: string, mimeType: string): Promise<Response> {
  const object = await c.env.MEDIA.get(r2Key);
  if (!object) {
    return c.json({ error: 'no audio yet' }, 404);
  }
  return new Response(object.body, {
    status: 200,
    headers: { 'Content-Type': mimeType || 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}

app.get('/v1/c/:id/audio/latest', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const row = await c.env.DB.prepare(
    'SELECT r2Key, mimeType FROM chunks_index WHERE eventId = ? ORDER BY sequence DESC LIMIT 1',
  )
    .bind(c.req.param('id'))
    .first<{ r2Key: string; mimeType: string }>();
  if (!row) {
    return c.json({ error: 'no audio yet' }, 404);
  }
  return streamChunk(c, row.r2Key, row.mimeType);
});

// All chunks concatenated, in order — a single playable stream. Used by the
// no-MSE fallback player and as a download for evidence.
app.get('/v1/c/:id/audio/full', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    'SELECT r2Key, mimeType FROM chunks_index WHERE eventId = ? ORDER BY sequence ASC',
  )
    .bind(eventId)
    .all<{ r2Key: string; mimeType: string }>();
  const keys = results ?? [];
  if (keys.length === 0) {
    return c.json({ error: 'no audio yet' }, 404);
  }
  const media = c.env.MEDIA;
  const stream = new ReadableStream({
    async pull(controller) {
      // Pull all sequentially then close. (Chunks are ~1s of opus, small.)
      for (const k of keys) {
        const object = await media.get(k.r2Key);
        if (object) {
          controller.enqueue(new Uint8Array(await object.arrayBuffer()));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': keys[0]?.mimeType || 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
});

app.get('/v1/c/:id/audio/stream', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return audioStream(c, c.req.param('id'));
});

app.get('/v1/c/:id/location/stream', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return locationStream(c, c.req.param('id'));
});

// Numeric chunk-by-sequence — registered AFTER the named /audio/* routes so
// "latest" / "full" / "stream" are not captured by :sequence.
app.get('/v1/c/:id/audio/:sequence', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const sequence = Number(c.req.param('sequence'));
  if (!Number.isFinite(sequence)) {
    return c.json({ error: 'bad sequence' }, 400);
  }
  const row = await c.env.DB.prepare(
    'SELECT r2Key, mimeType FROM chunks_index WHERE eventId = ? AND sequence = ?',
  )
    .bind(c.req.param('id'), sequence)
    .first<{ r2Key: string; mimeType: string }>();
  if (!row) {
    return c.json({ error: 'not found' }, 404);
  }
  return streamChunk(c, row.r2Key, row.mimeType);
});

// "I AM RESPONDING": records the contact's response. It deliberately does NOT
// push an overt message to the user's phone — that would be visible to an
// aggressor and break the covert design. The dashboard updates its own button;
// the real human acknowledgment remains the contact's innocuous phone call.
app.post('/v1/c/:id/responding', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await audit(c.env, c.req.param('id'), 'contact.responding', null, null);
  return c.json({ ok: true }, 200);
});

// "SHARE LIVE LINK": mint a fresh 1-hour token for forwarding to a second
// responder. They get the same read-only view (no roles in v0).
app.get('/v1/c/:id/share', async (c) => {
  if (!(await requireMagicToken(c)) || !c.env.MAGIC_LINK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const token = await mintMagicToken(c.env.MAGIC_LINK_SECRET, eventId);
  const workerOrigin = new URL(c.req.url).origin;
  return c.json({ url: `${workerOrigin}/c/${eventId}?t=${token}` }, 200);
});

// Contact-side stand-down is DISABLED (Fix Brief 4 S2 + Brief 3 G3): a contact /
// responder can never end an alert. Only the user's verified lock code closes an
// event. We record the attempt for the trail and refuse to close.
app.post('/v1/c/:id/stand-down', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await audit(c.env, c.req.param('id'), 'contact_standdown_blocked', null, null);
  return c.json({ ok: false, closed: false, reason: 'requires_user_lock_code' }, 403);
});

// "Client lost" beacon (Fix Brief 1 #3). Sent via navigator.sendBeacon on
// pagehide, which can't carry signed headers — so the payload is body-signed:
// sig = HMAC(eventSecret, "LOST\n<eventId>\n<timestamp>"). Registered BEFORE the
// HMAC middleware so the header-less beacon is not rejected; it self-verifies.
// Marking "lost" ESCALATES (device went dark), it NEVER cancels — so even a
// forged beacon is fail-safe.
app.post('/v1/events/:id/lost', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req
    .json<{ timestamp?: number; sig?: string }>()
    .catch(() => ({}) as { timestamp?: number; sig?: string });
  if (typeof body.timestamp !== 'number' || !body.sig) {
    return c.json({ error: 'bad beacon' }, 400);
  }
  const row = await c.env.DB.prepare('SELECT hmacSecret, status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ hmacSecret: string; status: string }>();
  if (!row) {
    return c.json({ error: 'not found' }, 404);
  }
  const expected = await hmacSha256Hex(row.hmacSecret, `LOST\n${eventId}\n${body.timestamp}`);
  if (expected !== body.sig) {
    return c.json({ error: 'bad signature' }, 401);
  }
  if (row.status === 'active') {
    await c.env.DB.prepare('UPDATE events SET lostAt = ? WHERE id = ? AND lostAt IS NULL')
      .bind(Date.now(), eventId)
      .run();
    await audit(c.env, eventId, 'client_lost', null, null);
    const workerOrigin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(notifyEscalation(c.env, eventId, workerOrigin, 'client_lost'));
  }
  return c.body(null, 204);
});

// --- Authenticated event sub-routes ---
app.use('/v1/events/:id/*', hmacAuth);

// Heartbeat (Fix Brief 1 #3). Records lastHeartbeatAt; the Worker NEVER
// auto-closes on a missed beat — a missed heartbeat escalates via the scheduled
// integrity scan ("device went dark"), it does not cancel.
app.post('/v1/events/:id/heartbeat', async (c) => {
  const eventId = c.req.param('id');
  await c.env.DB.prepare('UPDATE events SET lastHeartbeatAt = ? WHERE id = ? AND status = ?')
    .bind(Date.now(), eventId, 'active')
    .run();
  return c.json({ ok: true }, 200);
});

// Stand down (Fix Brief 1 #3/#4). The ONLY path that closes an event from the
// user's side, and only with a server-VERIFIED lock code. The raw code is
// checked against the account's lockCodeHash / duressCodeHash:
//   - lock code  → close the event (closedBy = 'user_lock_code')
//   - duress code → ESCALATE (duress alert), do NOT close; recording continues
//                   and the event closes later only on confirmed voice contact
//                   (a contact-side stand-down)
//   - anything else → rejected; nothing changes
app.post('/v1/events/:id/standdown', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const workerOrigin = new URL(c.req.url).origin;
  const outcome = await attemptStandDown(c.env, eventId, body.code ?? '', workerOrigin, 'user_lock_code');
  switch (outcome) {
    case 'not_found':
      return c.json({ error: 'not found' }, 404);
    case 'already_closed':
    case 'closed':
      return c.json({ ok: true, closed: true }, 200);
    case 'duress':
      return c.json({ ok: true, closed: false, duress: true }, 200);
    case 'no_lock_code':
      return c.json({ error: 'no_verifiable_lock_code' }, 409);
    default:
      return c.json({ error: 'invalid_code' }, 403);
  }
});

app.post('/v1/events/:id/chunks/:sequence', async (c) => {
  const eventId = c.req.param('id');
  const sequence = Number(c.req.param('sequence'));
  const mimeType = c.req.header('X-Mime-Type') ?? 'application/octet-stream';
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'bin';
  const r2Key = `events/${eventId}/chunks/${sequence}.${ext}`;
  // Integrity (#C2): hash the chunk bytes on write and link into the event's
  // append-only hash chain before anything can touch the stored object.
  const sha256 = await hashBytes(bytes);
  const tz = await eventTzOffset(c.env, eventId);
  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO chunks_index (eventId, sequence, r2Key, sizeBytes, mimeType, createdAt, sha256, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, sequence, r2Key, bytes.byteLength, mimeType, Date.now(), sha256, tz)
    .run();
  await appendToChain(c.env, eventId, 'chunk', r2Key, sha256);
  return c.json({ ok: true, r2Key }, 201);
});

interface LocationPayload {
  points: Array<{ timestamp: number; lat: number; lon: number; accuracy?: number; speed?: number }>;
}
app.post('/v1/events/:id/locations', async (c) => {
  const eventId = c.req.param('id');
  const { points } = await c.req.json<LocationPayload>();
  if (points.length > 0) {
    const tz = await eventTzOffset(c.env, eventId);
    await c.env.DB.batch(
      points.map((p) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO locations_index (eventId, timestamp, lat, lon, accuracyM, speed, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(eventId, p.timestamp, p.lat, p.lon, p.accuracy ?? null, p.speed ?? null, tz),
      ),
    );
  }
  return c.json({ ok: true, count: points.length }, 201);
});

interface ClassificationPayloadItem {
  timestamp: number;
  threatLevel?: string;
  matchedCategories?: unknown;
  toneIndicators?: unknown;
  summary?: string;
  languages?: unknown;
}
app.post('/v1/events/:id/classifications', async (c) => {
  const eventId = c.req.param('id');
  const { items } = await c.req.json<{ items: ClassificationPayloadItem[] }>();
  if (items.length > 0) {
    await c.env.DB.batch(
      items.map((item) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO classifications_index (eventId, timestamp, threatLevel, matchedCategoriesJson, toneIndicatorsJson, summaryText, languagesJson) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          eventId,
          item.timestamp,
          item.threatLevel ?? null,
          JSON.stringify(item.matchedCategories ?? []),
          JSON.stringify(item.toneIndicators ?? []),
          item.summary ?? null,
          JSON.stringify(item.languages ?? []),
        ),
      ),
    );
  }
  return c.json({ ok: true, count: items.length }, 201);
});

interface TranscriptPayload {
  fragments: Array<{ sequence: number; text: string; isFinal?: boolean }>;
}
app.post('/v1/events/:id/transcripts', async (c) => {
  const eventId = c.req.param('id');
  const { fragments } = await c.req.json<TranscriptPayload>();
  if (fragments.length > 0) {
    await c.env.DB.batch(
      fragments.map((f) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO transcripts_index (eventId, sequence, text, isFinal, createdAt) VALUES (?, ?, ?, ?, ?)',
        ).bind(eventId, f.sequence, f.text, f.isFinal ? 1 : 0, Date.now()),
      ),
    );
  }
  return c.json({ ok: true, count: fragments.length }, 201);
});

// Frozen ORIGIN snapshot (Fix Brief 5 D1). Write-once: INSERT OR IGNORE so the
// immutable "initial contact" anchor never changes once captured.
interface OriginPayload {
  triggerType?: string;
  dtgStart?: number;
  tzOffsetMinutes?: number;
  location?: { lat?: number; lon?: number; accuracy?: number } | null;
  audioFromSeq?: number;
  audioToSeq?: number;
  categories?: string[];
  threatLevel?: string;
  voiceCount?: number;
}
app.post('/v1/events/:id/origin', async (c) => {
  const eventId = c.req.param('id');
  const b = await c.req.json<OriginPayload>().catch(() => ({}) as OriginPayload);
  const trigger = b.triggerType === 'deadman' || b.triggerType === 'tamper' ? b.triggerType : 'manual';
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO event_origin (eventId, triggerType, dtgStart, tzOffsetMinutes, lat, lon, accuracyM, audioFromSeq, audioToSeq, initialCategoriesJson, initialThreatLevel, initialVoiceCount, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      eventId,
      trigger,
      b.dtgStart ?? Date.now(),
      b.tzOffsetMinutes ?? null,
      b.location?.lat ?? null,
      b.location?.lon ?? null,
      b.location?.accuracy ?? null,
      b.audioFromSeq ?? null,
      b.audioToSeq ?? null,
      JSON.stringify(b.categories ?? []),
      b.threatLevel ?? null,
      typeof b.voiceCount === 'number' ? b.voiceCount : null,
      Date.now(),
    )
    .run();
  return c.json({ ok: true }, 201);
});

// Delivery + closure status the PWA polls. Its only on-device effect is the
// closure teardown (when status is closed by contact_approval). The `delivered`
// field is informational only — there is no on-device delivery feedback.
app.get('/v1/events/:id/delivery-status', async (c) => {
  const eventId = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT notifiedAt, notifyChannel, status, closedBy FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      notifiedAt: number | null;
      notifyChannel: string | null;
      status: string;
      closedBy: string | null;
    }>();
  if (!row) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(
    {
      delivered: row.notifiedAt != null,
      channel: row.notifyChannel,
      deliveredAt: row.notifiedAt,
      status: row.status,
      closedBy: row.closedBy,
    },
    200,
  );
});

// Closure request: the user submitted a pin. The Worker does NOT validate the
// pin (the client decided normal vs duress vs wrong, and only calls here for the
// first two). It records the request and routes the matching message to the
// contact through the channel router.
app.post('/v1/events/:id/close-request', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req
    .json<{ pinHashWithSalt?: string; duress?: boolean }>()
    .catch(() => ({}) as { pinHashWithSalt?: string; duress?: boolean });
  const duress = body.duress === true;

  const event = await c.env.DB.prepare('SELECT userId, userHash, status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null; status: string }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE events SET closeRequestedAt = ?, closeRequestDuress = ? WHERE id = ?',
  )
    .bind(Date.now(), duress ? 1 : 0, eventId)
    .run();
  await audit(c.env, eventId, duress ? 'closure.duress_requested' : 'closure.requested', null, {
    pinHashWithSalt: body.pinHashWithSalt ?? null,
  });

  const contact = await getContactForEvent(c.env, event);
  if (contact) {
    // Channels without inline buttons (email) link to the dashboard; mint a
    // fresh token if the magic-link key is configured.
    let dashboardUrl: string | undefined;
    if (c.env.MAGIC_LINK_SECRET) {
      const token = await mintMagicToken(c.env.MAGIC_LINK_SECRET, eventId);
      dashboardUrl = `${new URL(c.req.url).origin}/c/${eventId}?t=${token}`;
    }
    const payload = { userDisplayName: contact.displayName, dashboardUrl };
    const message = duress
      ? ({ kind: 'duress', eventId, payload } as const)
      : ({ kind: 'closure', eventId, payload } as const);
    c.executionCtx.waitUntil(dispatch(c.env, contact.id, message));
  }

  return c.json({ ok: true, duress }, 200);
});

// The generic no-code close is DISABLED (Fix Brief 4 S2). The ONLY way to close
// an active event is the verified lock code via /v1/events/:id/standdown (PWA)
// or /v1/c/:id/standdown (coordinator, with the user's code).
app.post('/v1/events/:id/close', async (c) => {
  await audit(c.env, c.req.param('id'), 'event.close_blocked', null, null);
  return c.json({ ok: false, reason: 'requires_user_lock_code' }, 403);
});

// fetch + scheduled (Cron Trigger). The scheduled handler runs the
// device-went-dark escalation and the vault integrity scan.
export default {
  fetch: app.fetch,
  scheduled,
};
