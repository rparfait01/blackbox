import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { randomHex } from '@blackbox/shared';
import { hmacAuth } from './auth';
import { audit } from './lib/audit';
import {
  getContact,
  getContactEndpoints,
  listContacts,
  listFollows,
  upsertContact,
} from './lib/contacts';
import { notifyActivation } from './lib/notify';
import { mintMagicToken, verifyMagicToken, verifyMagicTokenDetailed } from './lib/magic-link';
import { getContactState } from './lib/contact-state';
import { renderDashboardPage, renderTokenPage } from './dashboard/page';
import { audioStream, locationStream } from './routes/contact-streams';
import { dispatch } from './channels/router';
import { formatLocalTime } from './lib/contact-state';
import { handleLineWebhook } from './routes/line-webhook';
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

// --- Create event (no auth: this mints the per-event secret) ---
app.post('/v1/events', async (c) => {
  const body = await c.req
    .json<{ userHash?: string; source?: string; startTime?: number; locale?: string }>()
    .catch(() => ({}) as { userHash?: string; source?: string; startTime?: number; locale?: string });
  const eventId = crypto.randomUUID();
  const hmacSecret = randomHex(32);
  const createdAt = Date.now();
  const userHash = body.userHash ?? '';
  await c.env.DB.prepare(
    'INSERT INTO events (id, createdAt, status, userHash, hmacSecret, source, locale) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, createdAt, 'active', userHash, hmacSecret, body.source ?? null, body.locale ?? null)
    .run();
  await audit(c.env, eventId, 'event.create', userHash || null, { source: body.source });

  // Push the activation alert to the contact off the response path (records
  // events.notifiedAt on success). Nothing is signalled back to the user's
  // phone; this never blocks the 201 below.
  const workerOrigin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(notifyActivation(c.env, eventId, userHash, workerOrigin));

  return c.json({ eventId, hmacSecret, createdAt }, 201);
});

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
  return verifyMagicToken(secret, eventId, token);
}

// The full dashboard HTML page (loud, contact-facing). Token verdict drives a
// friendly expired/invalid page instead of a bare 401 body.
app.get('/c/:id', async (c) => {
  const secret = c.env.MAGIC_LINK_SECRET;
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const verdict = secret
    ? await verifyMagicTokenDetailed(secret, eventId, token)
    : ('invalid' as const);
  if (verdict !== 'ok') {
    return c.html(renderTokenPage(verdict === 'expired' ? 'expired' : 'invalid'), 401);
  }
  const state = await getContactState(c.env, eventId);
  if (!state) {
    return c.html(renderTokenPage('invalid'), 404);
  }
  const workerOrigin = new URL(c.req.url).origin;
  return c.html(renderDashboardPage({ eventId, token, base: workerOrigin, state }));
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

// "HOLD 3S TO STAND DOWN": the contact's deliberate path to end an alert without
// the user's pin — used when they know the situation is resolved (they reached
// the user, the user is safe). Closes the event; the PWA's closure monitor then
// tears down capture/upload/geolocation. NOTHING is pushed to the user's phone.
app.post('/v1/c/:id/stand-down', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const event = await c.env.DB.prepare('SELECT userHash, status, locale FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userHash: string; status: string; locale: string | null }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }
  if (event.status !== 'closed') {
    await c.env.DB.prepare('UPDATE events SET status = ?, closedAt = ?, closedBy = ? WHERE id = ?')
      .bind('closed', Date.now(), 'contact_stand_down', eventId)
      .run();
  }

  const contact = await getContact(c.env, event.userHash);
  let channelUserId: string | null = null;
  if (contact) {
    const endpoints = await getContactEndpoints(c.env, contact.id);
    channelUserId = endpoints.find((e) => e.channel === 'line')?.channelIdentifier ?? null;
  }
  await audit(c.env, eventId, 'stand_down_by_contact', null, { channelUserId });

  // Confirm to the contact (routed; never to the user).
  if (contact) {
    const time = formatLocalTime(event.locale, Date.now());
    c.executionCtx.waitUntil(
      dispatch(c.env, contact.id, { kind: 'standDownConfirmation', eventId, payload: { time } }),
    );
  }
  return c.json({ ok: true }, 200);
});

// --- Authenticated event sub-routes ---
app.use('/v1/events/:id/*', hmacAuth);

app.post('/v1/events/:id/chunks/:sequence', async (c) => {
  const eventId = c.req.param('id');
  const sequence = Number(c.req.param('sequence'));
  const mimeType = c.req.header('X-Mime-Type') ?? 'application/octet-stream';
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'bin';
  const r2Key = `events/${eventId}/chunks/${sequence}.${ext}`;
  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO chunks_index (eventId, sequence, r2Key, sizeBytes, mimeType, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, sequence, r2Key, bytes.byteLength, mimeType, Date.now())
    .run();
  return c.json({ ok: true, r2Key }, 201);
});

interface LocationPayload {
  points: Array<{ timestamp: number; lat: number; lon: number; accuracy?: number; speed?: number }>;
}
app.post('/v1/events/:id/locations', async (c) => {
  const eventId = c.req.param('id');
  const { points } = await c.req.json<LocationPayload>();
  if (points.length > 0) {
    await c.env.DB.batch(
      points.map((p) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO locations_index (eventId, timestamp, lat, lon, accuracyM, speed) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(eventId, p.timestamp, p.lat, p.lon, p.accuracy ?? null, p.speed ?? null),
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

  const event = await c.env.DB.prepare('SELECT userHash, status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userHash: string; status: string }>();
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

  const contact = await getContact(c.env, event.userHash);
  if (contact) {
    const payload = { userDisplayName: contact.displayName };
    const message = duress
      ? ({ kind: 'duress', eventId, payload } as const)
      : ({ kind: 'closure', eventId, payload } as const);
    c.executionCtx.waitUntil(dispatch(c.env, contact.id, message));
  }

  return c.json({ ok: true, duress }, 200);
});

app.post('/v1/events/:id/close', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req
    .json<{ closedBy?: string }>()
    .catch(() => ({}) as { closedBy?: string });
  await c.env.DB.prepare('UPDATE events SET status = ?, closedAt = ?, closedBy = ? WHERE id = ?')
    .bind('closed', Date.now(), body.closedBy ?? null, eventId)
    .run();
  await audit(c.env, eventId, 'event.close', body.closedBy ?? null, null);
  return c.json({ ok: true }, 200);
});

export default app;
