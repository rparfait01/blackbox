import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomHex } from '@blackbox/shared';
import { hmacAuth } from './auth';
import type { Env, Vars } from './types';

/**
 * BLACK BOX API Worker (W5). Stores activation media + metadata. The Worker does
 * nothing with the data except store it — classification stays on-device. Logs
 * only requestId / endpoint / status / latency; never payload contents.
 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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
    allowHeaders: ['Content-Type', 'X-Event-Id', 'X-Timestamp', 'X-Signature', 'X-Mime-Type'],
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

async function audit(
  env: Env,
  eventId: string | null,
  action: string,
  actorHash: string | null,
  metadata: unknown,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (id, eventId, action, actorHash, timestamp, metadataJson) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        eventId,
        action,
        actorHash,
        Date.now(),
        metadata ? JSON.stringify(metadata) : null,
      )
      .run();
  } catch {
    console.log(JSON.stringify({ level: 'error', message: 'audit_failed', action }));
  }
}

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
  const body = await c.req.json<{ userHash?: string; source?: string; startTime?: number }>().catch(
    () => ({}) as { userHash?: string; source?: string; startTime?: number },
  );
  const eventId = crypto.randomUUID();
  const hmacSecret = randomHex(32);
  const createdAt = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO events (id, createdAt, status, userHash, hmacSecret, source) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, createdAt, 'active', body.userHash ?? '', hmacSecret, body.source ?? null)
    .run();
  await audit(c.env, eventId, 'event.create', body.userHash ?? null, { source: body.source });
  return c.json({ eventId, hmacSecret, createdAt }, 201);
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
