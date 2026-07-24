import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { hmacSha256Hex, randomHex } from '@blackbox/shared';
import { hmacAuth, sessionSecret } from './auth';
import { audit } from './lib/audit';
import { appendToChain, hashBytes, publicKeyB64, verifyManifest } from './lib/integrity';
import { crossesTamperingThreshold, TAMPERING_WINDOW_MS } from './lib/tampering';
import {
  evaluateConsent,
  overrideTamperingClose,
  recordSupportAssent,
  recordUserAssent,
} from './lib/closure-consent';
import { broadcastEventChange } from './event-channel';
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
import { getContactForEvent, listCascadeContacts, listContacts, listFollows, upsertContact } from './lib/contacts';
import { hasDeliverableRecipient } from './lib/roles';
import { advanceEventCascade, notifyActivation, notifyEscalation } from './lib/notify';
import { buildClosureReport, getClosureReport } from './lib/closure-report';
import { mintMagicToken, mintRoleToken, verifyTokenRole } from './lib/magic-link';
import { getCookie, setCookie } from 'hono/cookie';
import { verifySession } from './lib/session';
import { getContactState } from './lib/contact-state';
import { renderDashboardPage, renderNotifiedPage, renderTokenPage } from './dashboard/page';
import { renderCadSummary } from './dashboard/cad-summary';
import { audioStream, locationStream } from './routes/contact-streams';
import { dispatch } from './channels/router';
import { handleLineWebhook } from './routes/line-webhook';
import { handleTwilioWebhook } from './routes/twilio-webhook';
import { authRoutes } from './routes/auth';
import { guardianRoutes } from './routes/guardians';
import { userRoutes } from './routes/user';
import { orgRoutes } from './routes/org';
import { orgRegisterRoutes } from './routes/org-register';
import { createOrg, recordLicense } from './lib/org';
import { createAdminRegistrationCode, reissueRegistrationCode, revokeRegistrationCode } from './lib/org-registration';
import { SUPPRESSION_THRESHOLD, tallyAggregate } from './lib/tally';
import { intakeStatsAggregate } from './lib/intake-stats';
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
    // DELETE is required by contact removal (DELETE /v1/me/contacts/:slot) and
    // account deletion (DELETE /v1/me/account). Omitting it made the browser's
    // preflight reject those cross-origin requests, surfacing as a silent
    // "Could not clear" / "cannot remove contact" (Brief 13 B7).
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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

// --- Build version (no auth, Brief 21) — the live worker build stamp, injected at
// deploy via `wrangler deploy --var WORKER_BUILD:<git-sha>` ('dev' when unset).
// Lets the deploy script print the LIVE worker build alongside the PWA build so a
// server-newer-than-client split is visible immediately, not two weeks later. ---
app.get('/version', (c) => c.json({ version: c.env.WORKER_BUILD ?? 'dev' }, 200));

// --- Anonymous Incident Tally: published aggregate (Brief 25 §6). PUBLIC and
// unauthenticated by design — this is open public-good data (agencies, researchers,
// coalitions), independent of any BLACK BOX account. Returns only grouped counts with
// small-count suppression (cells below the threshold are dropped); never individual
// rows, and there is no identity in the store to recover. Read-only. ---
app.get('/v1/tally/stats', async (c) => {
  const cells = await tallyAggregate(c.env);
  return c.json({ suppressionThreshold: SUPPRESSION_THRESHOLD, cells }, 200);
});

// Brief 27 §5 Destination 1 — the published anonymized INTAKE aggregate. PUBLIC open data,
// same shared k-anonymity suppression as the tally; a SEVERED store with no path back to a
// case file or an account.
app.get('/v1/intake-stats/stats', async (c) => {
  const cells = await intakeStatsAggregate(c.env);
  return c.json({ suppressionThreshold: SUPPRESSION_THRESHOLD, cells }, 200);
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

// --- Custody integrity: published verification key + manifest verify (Brief 15 §F).
// The Ed25519 public key (SPKI base64) is published so any recipient/court can
// verify an exported package out-of-band, independent of this server.
app.get('/.well-known/blackbox-integrity-public-key.json', async (c) => {
  const publicKey = publicKeyB64(c.env);
  if (!publicKey) {
    return c.json({ error: 'no_signing_key' }, 503);
  }
  return c.json({ algorithm: 'Ed25519', format: 'spki-base64', publicKey }, 200);
});

// Convenience verifier: POST a signed export manifest, get back whether its
// Ed25519 signature checks out against the manifest's published key. Stateless,
// no auth, never throws — verification is a public, reproducible operation.
app.post('/v1/integrity/verify', async (c) => {
  let manifest: Record<string, unknown>;
  try {
    manifest = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ valid: false, error: 'invalid_json' }, 400);
  }
  const valid = await verifyManifest(manifest);
  return c.json({ valid }, 200);
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

/** The client dedups repeat triggers within this window; a resume for an event
 *  older than it is a genuine second press (decision A: intensify), not a
 *  same-gesture race/retry that should stay silent. */
const RETRIGGER_INTENSIFY_MS = 60_000;

interface CanonicalActive {
  id: string;
  hmacSecret: string;
  createdAt: number;
}

/**
 * ONE OPEN EVENT PER ACCOUNT (Brief 15). Resolve the account's single canonical
 * active event and collapse any orphans. Matches by userId OR userHash, because a
 * trigger carrying a session token keys on userId while a tokenless/legacy trigger
 * keys on userHash-only — and both can belong to the same device/account. userHash
 * is a per-install sha256, so an OR match never crosses accounts.
 *
 * The NEWEST match is canonical; every other active match is auto-closed
 * (superseded) so closing the canonical later resolves the account to fully
 * dormant with zero orphans — no open event is ever left unreachable. When a token
 * is present and the canonical was userHash-only, its userId is backfilled so
 * future userId-keyed triggers resume it directly and the 0017 index covers it.
 *
 * Returns the canonical active event, or null when the account has none (the
 * caller then creates one). Idempotent — re-running collapses to the same row.
 */
async function resolveSingleActive(
  c: AppContext,
  userId: string | null,
  userHash: string,
): Promise<CanonicalActive | null> {
  const { results } = await c.env.DB.prepare(
    `SELECT id, hmacSecret, createdAt, userId FROM events
      WHERE status = 'active'
        AND ( (? IS NOT NULL AND userId = ?) OR (? <> '' AND userHash = ?) )
      ORDER BY createdAt DESC`,
  )
    .bind(userId, userId, userHash, userHash)
    .all<{ id: string; hmacSecret: string; createdAt: number; userId: string | null }>();
  const rows = results ?? [];
  if (rows.length === 0) {
    return null;
  }
  const canonical = rows[0]!;
  const now = Date.now();
  // Close every non-canonical active event for this account (superseded), same
  // disposition shape as the operator force-close / 0017 dedupe.
  for (const row of rows.slice(1)) {
    await c.env.DB.prepare(
      'UPDATE events SET status = ?, closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ?, reasonSecured = ? WHERE id = ? AND status = ?',
    )
      .bind(
        'closed',
        now,
        'superseded_resume',
        now,
        'system',
        "auto-closed: superseded by the account's canonical active event (one-active-event-per-account enforcement)",
        row.id,
        'active',
      )
      .run();
    await audit(c.env, row.id, 'event.superseded', userHash || userId, { canonical: canonical.id });
  }
  // Heal a userHash-only orphan into the account. Safe: siblings are closed above,
  // so the one-active-per-user unique index cannot conflict.
  if (userId && canonical.userId == null) {
    await c.env.DB.prepare("UPDATE events SET userId = ? WHERE id = ? AND status = 'active'")
      .bind(userId, canonical.id)
      .run();
    await audit(c.env, canonical.id, 'event.account_healed', userHash || userId, { userId });
  }
  return { id: canonical.id, hmacSecret: canonical.hmacSecret, createdAt: canonical.createdAt };
}

/**
 * Build the resume 201 (same shape as a fresh create — eventId + hmacSecret +
 * createdAt — plus `resumed: true`, so the client transparently rejoins). Per
 * Brief 15 decision (A), a GENUINE re-trigger intensifies the LIVE event: it
 * records a repeat signal (audit) and pushes it to the open coordinator dashboard,
 * feeding the E3 repetition path. No second event is ever created. The contact
 * cascade is deliberately NOT re-fired here — that would spam channels and disturb
 * cascade timing; intensification is the coordinator-visible push + audit trail. A
 * same-gesture race (event younger than the client dedup window) resumes silently.
 */
async function resumeResponse(
  c: AppContext,
  existing: CanonicalActive,
  userId: string | null,
  userHash: string,
  source: string | undefined,
): Promise<Response> {
  await audit(c.env, existing.id, 'event.resume', userHash || userId, { source });
  if (Date.now() - existing.createdAt >= RETRIGGER_INTENSIFY_MS) {
    await audit(c.env, existing.id, 'event.retrigger', userHash || userId, { source });
    c.executionCtx.waitUntil(broadcastEventChange(c.env, existing.id, 'retrigger'));
  }
  return c.json(
    { eventId: existing.id, hmacSecret: existing.hmacSecret, createdAt: existing.createdAt, resumed: true },
    201,
  );
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

  // Brief 23: STAMP the owning account's org onto the event, frozen at activation
  // (like event_origin). Account-less events (userId NULL — covert/tokenless) stay
  // orgId NULL = un-tenanted/individual. Reading a local column keeps every capture/
  // dashboard query join-free and keeps the org attribution immutable if the owner
  // is later deleted.
  const owner = userId
    ? await c.env.DB.prepare('SELECT orgId FROM users WHERE id = ?')
        .bind(userId)
        .first<{ orgId: string | null }>()
    : null;
  const orgId = owner?.orgId ?? null;

  // ONE OPEN EVENT PER ACCOUNT (Brief 15: data-layer guarantee + resolution).
  // Resolve the account's single canonical active event — matched by userId when a
  // token resolves one, else by userHash — collapsing any orphaned duplicates.
  // Triggering while the account is already live RESUMES that event and (decision
  // A) intensifies it; it NEVER stacks a second. This works even when userId is
  // NULL, the gap that previously let tokenless/legacy triggers accumulate zombies.
  const existing = await resolveSingleActive(c, userId, userHash);
  if (existing) {
    return resumeResponse(c, existing, userId, userHash, body.source);
  }
  // THE BUTTON ALWAYS FIRES. A zero-recipient account still opens an event and
  // still captures: someone in danger is in danger whether or not their contact
  // list is populated, and a refused trigger is the one failure this product
  // cannot ship. This previously 409'd (no_deliverable_recipient) to prevent an
  // alert that notifies no one from becoming an orphaned, unclosable event —
  // that deadlock is now handled downstream instead, by closeOrphanedEvents and
  // the dark+unclaimed auto-close, so it no longer costs a dead panic button.
  // "Everybody has somebody" is enforced at SETUP and by a standing warning; it
  // is never enforced here. The user is told the truth about who is being
  // reached on the active screen — never given false comfort, never blocked.
  const deliverable = userId ? await hasDeliverableRecipient(c.env, userId) : true;
  if (!deliverable) {
    // Not a gate — a trace. The event proceeds; this records that it opened with
    // no one to notify (recording-only), which the active screen states plainly.
    await audit(c.env, null, 'event.create_no_recipient', userHash || userId, {
      reason: 'no_deliverable_recipient',
    });
  }

  // lastHeartbeatAt seeds to createdAt so a brand-new event is never instantly
  // flagged "dark" before the first heartbeat lands.
  try {
    await c.env.DB.prepare(
      'INSERT INTO events (id, createdAt, status, userHash, userId, orgId, hmacSecret, source, locale, tzOffsetMinutes, lastHeartbeatAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        eventId,
        createdAt,
        'active',
        userHash,
        userId,
        orgId,
        hmacSecret,
        body.source ?? null,
        body.locale ?? null,
        tzOffsetMinutes,
        createdAt,
      )
      .run();
  } catch (error) {
    // Either partial unique index (userId — 0017, or userHash — 0027) is the hard
    // backstop against a race that slipped past resolveSingleActive above: if a
    // concurrent request already opened the account's active event, resolve +
    // resume that one instead of failing. Covers the tokenless class too.
    const raced = await resolveSingleActive(c, userId, userHash);
    if (raced) {
      return resumeResponse(c, raced, userId, userHash, body.source);
    }
    throw error;
  }
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

// --- Mounted route groups (auth, guardians, user/settings, org portal) ---
app.route('/v1/auth', authRoutes);
app.route('/v1/guardians', guardianRoutes);
app.route('/v1/me', userRoutes);
// Brief 24 — org admin registration at its OWN base path (distinct from the
// session-gated /v1/org portal group): the public read-only GET /v1/org-register/:code
// is reachable without a session; the completion POST applies requireSession itself.
app.route('/v1/org-register', orgRegisterRoutes);
// Brief 23 — the org portal surface. Every route inside is session + org-role gated
// and scoped to the caller's own org; individual accounts never reach it.
app.route('/v1/org', orgRoutes);

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

// Brief 24 §1 — operator bootstrap (AFTER out-of-band human vetting): create the org
// RECORD (name, lane, seats, term — no payment processing) + a single-use ADMIN
// REGISTRATION code bound to this org. The operator delivers the code SEPARATELY from
// the approval link to the named individual, who registers admin #1 (§1 step 5). This
// issues a REGISTRATION code, never an enrollment code — a registration code can only
// ever create admin #1 on THIS org; it can never confer a seat or a coordinator.
app.post('/v1/admin/orgs', async (c) => {
  const body = await c.req
    .json<{ name?: string; lane?: string; seatsTotal?: number; termStart?: number; termEnd?: number }>()
    .catch(() => ({}) as { name?: string; lane?: string; seatsTotal?: number; termStart?: number; termEnd?: number });
  const name = (body.name ?? '').trim();
  const lane = body.lane === 'paid' ? 'paid' : body.lane === 'zero_fee' ? 'zero_fee' : null;
  if (!name || !lane) {
    return c.json({ error: 'name and lane (zero_fee|paid) are required' }, 400);
  }
  const seatsTotal = typeof body.seatsTotal === 'number' && body.seatsTotal >= 0 ? body.seatsTotal : 0;
  const org = await createOrg(c.env, { name, lane });
  const license = await recordLicense(c.env, {
    orgId: org.id,
    seatsTotal,
    termStart: typeof body.termStart === 'number' ? body.termStart : null,
    termEnd: typeof body.termEnd === 'number' ? body.termEnd : null,
  });
  const reg = await createAdminRegistrationCode(c.env, { orgId: org.id, createdBy: null });
  await audit(c.env, null, 'admin.org_create', null, { orgId: org.id, lane, seatsTotal });
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

// Brief 24 §6 — operator escape hatches (logged with reason). Re-issue a fresh
// registration code (revoking any live one) when a code expired, went to the wrong
// person, or admin #1 left before adding admin #2; or revoke a live code outright.
app.post('/v1/admin/orgs/:orgId/registration-code/reissue', async (c) => {
  const orgId = c.req.param('orgId');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return c.json({ error: 'reason required (this is a logged privileged action)' }, 400);
  }
  const fresh = await reissueRegistrationCode(c.env, orgId, reason, null);
  return c.json({ registrationCode: fresh.code, registrationExpiresAt: fresh.expiresAt }, 201);
});

app.post('/v1/admin/orgs/:orgId/registration-code/revoke', async (c) => {
  const body = await c.req.json<{ code?: string; reason?: string }>().catch(() => ({}) as { code?: string; reason?: string });
  const code = (body.code ?? '').trim();
  const reason = (body.reason ?? '').trim();
  if (!code || !reason) {
    return c.json({ error: 'code and reason required' }, 400);
  }
  const ok = await revokeRegistrationCode(c.env, code, reason, null);
  if (!ok) {
    return c.json({ error: 'code_not_found_or_already_redeemed' }, 404);
  }
  return c.json({ revoked: true }, 200);
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

// --- Operator failsafe (Bearer ADMIN_TOKEN): list + force-close orphaned active
// events. A defined, audited admin action so a truly orphaned event (no reachable
// coordinator, all links expired) can always be closed without trapping the user.
// This is an OPERATOR action, not a user self-close — the user still cannot close
// their own event (that protects a coerced user). See docs/OPERATOR_RUNBOOK.md.
app.get('/v1/admin/events/active', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.userId, e.userHash, e.createdAt, e.notifiedAt, e.escalatedAt,
            e.coordinatorClaimedAt, e.lastLinkIssuedAt, e.linkReissueCount, u.email, u.name
       FROM events e LEFT JOIN users u ON u.id = e.userId
      WHERE e.status = 'active' ORDER BY e.createdAt DESC`,
  ).all();
  return c.json({ active: results ?? [] }, 200);
});

app.post('/v1/admin/events/:id/force-close', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason =
    body.reason?.trim() ||
    'operator force-close — orphaned event, no reachable coordinator';
  const event = await c.env.DB.prepare('SELECT status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ status: string }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }
  if (event.status === 'closed') {
    return c.json({ ok: true, alreadyClosed: true }, 200);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE events SET status = ?, closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ?, reasonSecured = ? WHERE id = ? AND status = ?',
  )
    .bind('closed', now, 'operator_force_close', now, 'operator', reason, eventId, 'active')
    .run();
  await audit(c.env, eventId, 'operator_force_close', null, { reason });
  return c.json({ ok: true, closed: true, reason }, 200);
});

// Read-only event observability for the standing acceptance suite (Bearer
// ADMIN_TOKEN) — lets the suite verify cascade timing + per-channel delivery on the
// DEPLOYED app without direct D1 access. Admin already sees active-event PII, so
// this adds no new trust boundary.
app.get('/v1/admin/events/:id/audit', async (c) => {
  const eventId = c.req.param('id');
  const action = c.req.query('action');
  const stmt = action
    ? c.env.DB.prepare(
        'SELECT timestamp, action, metadataJson FROM audit_log WHERE eventId = ? AND action = ? ORDER BY timestamp ASC',
      ).bind(eventId, action)
    : c.env.DB.prepare(
        'SELECT timestamp, action, metadataJson FROM audit_log WHERE eventId = ? ORDER BY timestamp ASC',
      ).bind(eventId);
  const { results } = await stmt.all<{ timestamp: number; action: string; metadataJson: string | null }>();
  const rows = (results ?? []).map((r) => {
    let step: number | undefined;
    try {
      step = r.metadataJson ? (JSON.parse(r.metadataJson).step as number | undefined) : undefined;
    } catch {
      step = undefined;
    }
    return { timestamp: r.timestamp, action: r.action, step };
  });
  return c.json({ rows }, 200);
});

app.get('/v1/admin/events/:id/deliveries', async (c) => {
  const eventId = c.req.param('id');
  const channel = c.req.query('channel');
  const status = c.req.query('status');
  const kind = c.req.query('kind');
  let sql = 'SELECT COUNT(*) AS count FROM delivery_records WHERE eventId = ?';
  const binds: string[] = [eventId];
  if (channel) {
    sql += ' AND channel = ?';
    binds.push(channel);
  }
  if (status) {
    sql += ' AND status = ?';
    binds.push(status);
  }
  if (kind) {
    sql += ' AND messageKind = ?';
    binds.push(kind);
  }
  const row = await c.env.DB.prepare(sql)
    .bind(...binds)
    .first<{ count: number }>();
  return c.json({ count: row?.count ?? 0 }, 200);
});

// --- LINE webhook (no HMAC auth; verifies its own x-line-signature) ---
app.post('/v1/webhooks/line', handleLineWebhook);
// Contact Consent §2: pending SMS contacts reply YES/NO/STOP here.
app.post('/v1/webhooks/twilio', handleTwilioWebhook);

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
  // form. Coordinator is claimed only by a DELIBERATE "Take coordination" POST
  // (Brief 7 / grooming): merely opening the link must NOT claim it, or duress
  // would route to whoever happened to open first. Until someone claims, every
  // opener sees the location-only view with a Take-coordination button.
  const state = await getContactState(c.env, eventId);
  if (!state) {
    return c.html(renderTokenPage('invalid'), 404);
  }
  const row = await c.env.DB.prepare(
    'SELECT coordinatorKey, coordinatorClaimedAt FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{ coordinatorKey: string | null; coordinatorClaimedAt: number | null }>();
  const claimed = row?.coordinatorClaimedAt != null;
  const cookieKey = getCookie(c, 'bbcoord');
  const isCoordinator = claimed && !!cookieKey && cookieKey === row?.coordinatorKey;
  if (isCoordinator) {
    await audit(c.env, eventId, 'coordinator_view', null, null);
    return c.html(
      renderDashboardPage({ eventId, token, base: workerOrigin, state, role: 'coordinator' }),
    );
  }
  // Location-only view. Offer to take coordination only when unclaimed.
  await audit(c.env, eventId, claimed ? 'notified_view' : 'claimable_view', null, null);
  return c.html(renderNotifiedPage({ eventId, base: workerOrigin, state, claimable: !claimed }));
});

// Deliberate coordinator claim (Brief 7 / grooming). Atomic: the first POST that
// flips coordinatorClaimedAt from NULL wins and gets the bbcoord cookie; everyone
// else is told it is already claimed. This is the ONLY way coordination is taken
// — never by passively loading the dashboard.
app.post('/v1/c/:id/claim-coordinator', async (c) => {
  const secret = c.env.MAGIC_LINK_SECRET;
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const verdict = secret ? await verifyTokenRole(secret, eventId, token) : null;
  // Guardian-path tokens only; the dispatch (authority) path never coordinates.
  if (!verdict || verdict.verdict !== 'ok' || verdict.role === 'dispatch') {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const newKey = randomHex(16);
  // Brief 0B §3 race safety: only an ACTIVE, unclaimed event can be claimed. If a
  // solo survivor closed it a moment earlier, the claim matches zero rows and is
  // reported already-claimed/closed — no window where a solo close and a claim both
  // succeed on the same event.
  const claim = await c.env.DB.prepare(
    "UPDATE events SET coordinatorClaimedAt = ?, coordinatorKey = ? WHERE id = ? AND coordinatorClaimedAt IS NULL AND status = 'active'",
  )
    .bind(Date.now(), newKey, eventId)
    .run();
  if (claim.meta.changes === 1) {
    setCookie(c, 'bbcoord', newKey, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24,
    });
    await audit(c.env, eventId, 'coordinator_claimed', null, null);
    return c.json({ claimed: true }, 200);
  }
  // Already claimed — if it's this viewer, report success (idempotent).
  const row = await c.env.DB.prepare('SELECT coordinatorKey FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ coordinatorKey: string | null }>();
  const cookieKey = getCookie(c, 'bbcoord');
  if (cookieKey && row?.coordinatorKey === cookieKey) {
    return c.json({ claimed: true }, 200);
  }
  return c.json({ claimed: false, reason: 'already_claimed' }, 409);
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
// The coordinator code-entry stand-down is DISABLED (canonical closure rule). A
// contact / coordinator NEVER enters the user's code — that would be a second,
// ungated close path. The only coordinator close is POST /v1/c/:id/secure, which
// merely APPROVES a pending user closure request. Kept as a hard 403 so any stale
// caller fails closed.
app.post('/v1/c/:id/standdown', async (c) => {
  await audit(c.env, c.req.param('id'), 'coordinator_standdown_blocked', null, null);
  return c.json({ ok: false, closed: false, reason: 'coordinator_cannot_enter_code' }, 403);
});

// COORDINATOR SECURES the alert (Brief 9 Phase D). The deliberate close — only
// the current coordinator can do it, after the explicit "Are you sure" client
// confirmation. Generates the write-once closure report (Phase E) and confirms
// to the network. Duress (unsat) does NOT block securing — the coordinator
// validates with judgment — but the dashboard marks it unmistakably.
app.post('/v1/c/:id/secure', async (c) => {
  const eventId = c.req.param('id');
  if (!(await requireCoordinator(c, eventId))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const secureBody = await c.req
    .json<{ override?: boolean; overrideReason?: string }>()
    .catch(() => ({}) as { override?: boolean; overrideReason?: string });
  const event = await c.env.DB
    .prepare('SELECT status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ status: string }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  // §2: record the SUPPORT side's assent. Symmetric + order-independent — this is
  // a Request/Confirm, NOT a unilateral close. It closes only once the user has
  // ALSO assented (their gesture). Neither side ever closes alone.
  if (event.status !== 'closed') {
    await recordSupportAssent(c.env, eventId, 'coordinator');
  }
  const result = await evaluateConsent(c.env, eventId, waitUntil);
  if (result === 'closed' || result === 'already_closed') {
    return c.json({ ok: true, secured: true }, 200);
  }
  if (result === 'awaiting_user') {
    // The coordinator initiated; the user has not yet assented. Queued, not closed.
    return c.json({ ok: true, secured: false, queued: true, awaitingUser: true }, 200);
  }
  if (result === 'tampering_blocked') {
    // §E4: a TAMPERING event never clean-closes without an explicit, logged override.
    const reason = (secureBody.overrideReason ?? '').trim();
    if (secureBody.override !== true || reason.length === 0) {
      await audit(c.env, eventId, 'secure_rejected_tampering', null, null);
      return c.json(
        {
          error: 'tampering_requires_override',
          message:
            'Repeated duress signals flagged this event as TAMPERING. Do not assume safe. Securing requires an explicit override and a reason.',
        },
        409,
      );
    }
    await audit(c.env, eventId, 'tampering_override_secured', null, JSON.stringify({ reason }));
    await overrideTamperingClose(c.env, eventId, waitUntil);
    return c.json({ ok: true, secured: true }, 200);
  }
  return c.json({ error: 'not found' }, 404);
});

// The closure status report (coordinator-only) — the artifact reviewed at close.
app.get('/v1/c/:id/closure-report', async (c) => {
  const eventId = c.req.param('id');
  if (!(await requireCoordinator(c, eventId))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const report = (await getClosureReport(c.env, eventId)) ?? (await buildClosureReport(c.env, eventId))?.report;
  if (!report) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(report, 200);
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

// §4: live dashboard subscription over WebSocket. The dashboard connects here and
// the worker pushes a "changed" signal on every lifecycle event; the dashboard
// re-fetches /state on the signal. Server push, not polling. Same magic-token
// auth as /state. Falls back to 503 where the DO binding is absent (the dashboard
// then keeps polling).
app.get('/v1/c/:id/subscribe', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'expected_websocket' }, 426);
  }
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (!c.env.EVENT_CHANNEL) {
    return c.json({ error: 'push_unavailable' }, 503);
  }
  const eventId = c.req.param('id');
  const stub = c.env.EVENT_CHANNEL.get(c.env.EVENT_CHANNEL.idFromName(eventId));
  return stub.fetch(c.req.raw);
});

// §5: CAD-ready dispatch summary — the structured, READ-ONLY view the emergency
// services tier receives via the ESCALATION path (the direct-share path renders
// the live dashboard instead). Any valid event token may view it; access is
// logged; the token expires after the event. No closure/consent control here.
app.get('/v1/c/:id/dispatch-summary', async (c) => {
  if (!(await requireMagicToken(c))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const eventId = c.req.param('id');
  const state = await getContactState(c.env, eventId);
  if (!state) {
    return c.json({ error: 'not found' }, 404);
  }
  const subj = await c.env.DB.prepare('SELECT u.name AS name FROM events e LEFT JOIN users u ON u.id = e.userId WHERE e.id = ?')
    .bind(eventId)
    .first<{ name: string | null }>();
  await audit(c.env, eventId, 'dispatch_summary_viewed', null, null);
  return c.html(renderCadSummary({ eventId, subjectName: subj?.name ?? 'Unknown subject', state }));
});

/** Parse a single HTTP Range header against a known total size. */
function parseRange(header: string, total: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) {
    return null;
  }
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  let start: number;
  let end: number;
  if (!hasStart) {
    if (!hasEnd) {
      return null;
    }
    // suffix: last N bytes
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return null;
  }
  return { start, end };
}

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
    'SELECT r2Key, mimeType, sizeBytes FROM chunks_index WHERE eventId = ? ORDER BY sequence ASC',
  )
    .bind(eventId)
    .all<{ r2Key: string; mimeType: string; sizeBytes: number }>();
  const keys = results ?? [];
  if (keys.length === 0) {
    return c.json({ error: 'no audio yet' }, 404);
  }
  const media = c.env.MEDIA;
  const mime = keys[0]?.mimeType || 'application/octet-stream';
  const total = keys.reduce((sum, k) => sum + (k.sizeBytes || 0), 0);

  // HTTP Range support (Fix Brief 8): media elements — iOS Safari especially —
  // require byte-range / 206 responses, or the <audio> element errors. Without
  // this the concatenated recording would not play (this was the audio "ERROR").
  const rangeHeader = c.req.header('Range');
  const range = rangeHeader ? parseRange(rangeHeader, total) : null;
  if (rangeHeader && !range) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
    });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;

  const stream = new ReadableStream({
    async start(controller) {
      let offset = 0;
      for (const k of keys) {
        const size = k.sizeBytes || 0;
        const chunkStart = offset;
        const chunkEnd = offset + size - 1;
        offset += size;
        if (size === 0 || chunkEnd < start || chunkStart > end) {
          continue; // wholly outside the requested range
        }
        const from = Math.max(start, chunkStart) - chunkStart;
        const len = Math.min(end, chunkEnd) - chunkStart - from + 1;
        const object =
          from === 0 && len === size
            ? await media.get(k.r2Key)
            : await media.get(k.r2Key, { range: { offset: from, length: len } });
        if (object) {
          controller.enqueue(new Uint8Array(await object.arrayBuffer()));
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
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
  // Drive the contact cascade on the device's own ~10s heartbeat cadence (Brief
  // 11 timing). The in-request activation stagger can be cut short when waitUntil
  // is reclaimed (~40s) and the 1-min cron is too coarse for the 10s windows, so
  // each heartbeat advances any due steps — precise timing without new infra. The
  // atomic per-step claim makes this safe alongside the stagger + cron. Best
  // effort, off the response path; never blocks or fails the heartbeat.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const ev = await c.env.DB.prepare(
          "SELECT id, userId, userHash, createdAt, cascadeStep FROM events WHERE id = ? AND status = 'active' AND coordinatorClaimedAt IS NULL",
        )
          .bind(eventId)
          .first<{ id: string; userId: string | null; userHash: string | null; createdAt: number; cascadeStep: number }>();
        if (ev) {
          await advanceEventCascade(c.env, ev, new URL(c.req.url).origin);
        }
      } catch {
        // swallow — the 1-min cron backstops any tick that errors here
      }
    })(),
  );
  return c.json({ ok: true }, 200);
});

// Stand down — RETIRED (Brief 16 §1). The lock-code close path is gone: closure
// is gesture-only and runs entirely through dual consent (POST
// /v1/events/:id/closure-request — sat/unsat from the hold gesture — then the
// matching confirm). There is no code-based self-close from any side. Kept as a
// hard 410 so any stale caller fails closed instead of silently doing nothing.
app.post('/v1/events/:id/standdown', async (c) => {
  await audit(c.env, c.req.param('id'), 'standdown_retired_gesture_only', null, null);
  return c.json({ error: 'standdown_retired', message: 'Closure is gesture-only via dual consent.' }, 410);
});

// Closure REQUEST (Brief 9 Phase D). The user's PWA evaluates the 3-digit pin
// ON-DEVICE and sends only the resulting status (sat | unsat=duress) plus the
// reason — NEVER the pin. This does NOT close the event; the coordinator secures.
app.post('/v1/events/:id/closure-request', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req
    .json<{ status?: string; reasonSecured?: string }>()
    .catch(() => ({}) as { status?: string; reasonSecured?: string });
  const status = body.status === 'unsat' ? 'unsat' : body.status === 'sat' ? 'sat' : null;
  if (!status) {
    return c.json({ error: 'status must be sat or unsat' }, 400);
  }
  const event = await c.env.DB.prepare('SELECT status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ status: string }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }
  // §2: record the USER's assent (gesture-derived status).
  await recordUserAssent(c.env, eventId, status, body.reasonSecured ?? null);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);

  // §E3: repetition → tampering. Count duress assents in the rolling window (the
  // current one's audit row was just written, so it is included). Past the
  // threshold, escalate disposition to TAMPERING and raise severity — invisibly:
  // nothing the device can observe changes for signal #1…N.
  if (status === 'unsat') {
    const since = Date.now() - TAMPERING_WINDOW_MS;
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE eventId = ? AND action = 'user_assent_duress' AND timestamp >= ?",
    )
      .bind(eventId, since)
      .first<{ n: number }>();
    if (crossesTamperingThreshold(row?.n ?? 0)) {
      const ev = await c.env.DB.prepare('SELECT tamperingAt FROM events WHERE id = ?')
        .bind(eventId)
        .first<{ tamperingAt: number | null }>();
      if (ev?.tamperingAt == null) {
        await c.env.DB.prepare('UPDATE events SET tamperingAt = ? WHERE id = ?').bind(Date.now(), eventId).run();
        await audit(c.env, eventId, 'tampering_escalation', null, JSON.stringify({ count: row?.n ?? 0, windowMs: TAMPERING_WINDOW_MS }));
        // §4: tampering escalation is an in-app lifecycle signal — pushed live to
        // the open dashboard, never emailed.
        waitUntil(broadcastEventChange(c.env, eventId, 'tampering'));
      } else {
        await audit(c.env, eventId, 'tampering_repetition', null, JSON.stringify({ count: row?.n ?? 0 }));
      }
    }
  }

  // §2 dual consent: close now if SUPPORT already assented; otherwise the user's
  // assent (already pushed to the open dashboard by recordUserAssent) waits for
  // the coordinator's matching assent. No lifecycle email is sent (§4).
  const result = await evaluateConsent(c.env, eventId, waitUntil);
  if (result === 'closed') {
    return c.json({ ok: true, closed: true }, 200);
  }
  return c.json({ ok: true, closed: false, awaitingCoordinator: result === 'awaiting_support' }, 200);
});

// Closure-pin lockout (Brief 19 §6). The device reports 3 wrong (NOT duress) pin
// attempts. The pin itself never leaves the device — only this lockout signal. We
// record it (once) and surface it to the coordinator's live dashboard, because
// repeated failures can mean someone OTHER than the user is trying to close.
app.post('/v1/events/:id/closure-lockout', async (c) => {
  const eventId = c.req.param('id');
  const event = await c.env.DB.prepare('SELECT status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ status: string }>();
  if (!event) {
    return c.json({ error: 'not found' }, 404);
  }
  if (event.status === 'active') {
    await c.env.DB.prepare('UPDATE events SET closureLockoutAt = ? WHERE id = ? AND closureLockoutAt IS NULL')
      .bind(Date.now(), eventId)
      .run();
    await audit(c.env, eventId, 'closure_pin_lockout', null, null);
  }
  return c.json({ ok: true }, 200);
});

// Reason the event TRIGGERED — entered post-event (the user can't type during
// covert activation). Part of the closure status report.
app.post('/v1/events/:id/reason-triggered', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  await c.env.DB.prepare('UPDATE events SET reasonTriggered = ? WHERE id = ?')
    .bind(body.reason ?? null, eventId)
    .run();
  return c.json({ ok: true }, 200);
});

app.post('/v1/events/:id/chunks/:sequence', async (c) => {
  const eventId = c.req.param('id');
  const sequence = Number(c.req.param('sequence'));
  const mimeType = c.req.header('X-Mime-Type') ?? 'application/octet-stream';
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'bin';
  const r2Key = `events/${eventId}/chunks/${sequence}.${ext}`;
  // Integrity (#C2): hash the chunk bytes on write and link into the event's
  // append-only hash chain before anything can touch the stored object. The bytes are
  // opaque either way — plaintext today, ciphertext when the client is armed — so this
  // is unchanged by the envelope (the chain hashes whatever bytes arrive).
  const sha256 = await hashBytes(bytes);
  const tz = await eventTzOffset(c.env, eventId);
  // Brief 26 — optional envelope metadata. PRESENCE-gated: a plaintext upload sends
  // neither header and behaves exactly as before. The server never REQUIRES these (even
  // with the flag armed) — capture availability is paramount and the client fails open.
  const isFinal = c.req.header('X-Is-Final') === '1' ? 1 : 0;
  const commitment = (c.req.header('X-Plaintext-Commitment') ?? '').trim();
  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO chunks_index (eventId, sequence, r2Key, sizeBytes, mimeType, createdAt, sha256, tzOffsetMinutes, isFinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, sequence, r2Key, bytes.byteLength, mimeType, Date.now(), sha256, tz, isFinal)
    .run();
  await appendToChain(c.env, eventId, 'chunk', r2Key, sha256);
  // The signed PRE-ENCRYPTION plaintext commitment (change #1, admissibility): store it
  // and sign it into the SAME chain, so a later decryption is verifiable against a
  // capture-time commitment.
  if (commitment) {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO plaintext_commitments (eventId, sequence, plaintextHash, createdAt) VALUES (?, ?, ?, ?)',
    )
      .bind(eventId, sequence, commitment, Date.now())
      .run();
    await appendToChain(c.env, eventId, 'commitment', `${eventId}/${sequence}`, commitment);
  }
  return c.json({ ok: true, r2Key }, 201);
});

// Brief 26 — the per-capture wrapped data keys (states 3–4). One DEK per capture,
// wrapped to the survivor and (if enrolled) the org public key; uploaded once at capture
// start. Each wrappedDek is a sealed envelope (itself ciphertext under a public key), so
// the server stores it and can open none of it. hmac-authed like every event child route.
app.post('/v1/events/:id/wrapped-keys', async (c) => {
  const eventId = c.req.param('id');
  const body = await c.req
    .json<{ keys?: Array<{ recipientType?: string; recipientRef?: string; keyGeneration?: number; algId?: string; wrappedDek?: string }> }>()
    .catch(() => ({}) as { keys?: unknown });
  const keys = Array.isArray(body.keys) ? body.keys : [];
  let stored = 0;
  for (const k of keys) {
    const recipientType = k.recipientType === 'org' ? 'org' : k.recipientType === 'survivor' ? 'survivor' : null;
    if (!recipientType || !k.algId || !k.wrappedDek) continue;
    await c.env.DB.prepare(
      'INSERT INTO wrapped_keys (id, eventId, sequence, recipientType, recipientRef, keyGeneration, algId, wrappedDek, createdAt) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        eventId,
        recipientType,
        k.recipientRef ?? null,
        typeof k.keyGeneration === 'number' ? k.keyGeneration : 0,
        k.algId,
        k.wrappedDek,
        Date.now(),
      )
      .run();
    stored += 1;
  }
  return c.json({ ok: true, stored }, 201);
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
  // DTG must be the REAL activation time (Brief 12 P3): bind it to the event's
  // server-stamped createdAt, not the device clock (which can be skewed and was
  // the source of the "JUN 10" DTG mismatch). Falls back to the client value
  // only if the event row somehow can't be read.
  const ev = await c.env.DB.prepare('SELECT createdAt FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ createdAt: number }>();
  const dtgStart = ev?.createdAt ?? b.dtgStart ?? Date.now();
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO event_origin (eventId, triggerType, dtgStart, tzOffsetMinutes, lat, lon, accuracyM, audioFromSeq, audioToSeq, initialCategoriesJson, initialThreatLevel, initialVoiceCount, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      eventId,
      trigger,
      dtgStart,
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

// Delivery + closure status the PWA polls. Two on-device effects: the closure
// teardown (when status is closed by contact_approval), and the active screen's
// honest status line — `recipientCount` and `allChannelsFailed` are what let it
// say who is ACTUALLY being reached instead of always claiming "contacts are
// being notified". A safety tool must never hand back false comfort.
app.get('/v1/events/:id/delivery-status', async (c) => {
  const eventId = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT userId, userHash, notifiedAt, notifyChannel, status, closedBy, coordinatorPathFailedAt, escalationTier, cascadeStep FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      userId: string | null;
      userHash: string | null;
      notifiedAt: number | null;
      notifyChannel: string | null;
      status: string;
      closedBy: string | null;
      coordinatorPathFailedAt: number | null;
      escalationTier: string | null;
      cascadeStep: number;
    }>();
  if (!row) {
    return c.json({ error: 'not found' }, 404);
  }
  // The recipients the cascade will actually ATTEMPT — resolved from the same
  // list the cascade itself uses, so the status line can never disagree with what
  // the server is really doing. Resolved fresh: a contact added mid-event counts.
  const recipientCount = (await listCascadeContacts(c.env, { userId: row.userId, userHash: row.userHash })).length;
  const delivered = row.notifiedAt != null;
  // "Reached no one" is only HONEST once the cascade is exhausted: every step has
  // fired (cascadeStep counts fired steps) and not one delivery landed. Mid-cascade
  // failures are not yet a total failure — later steps may still land. The last
  // step's send can be in flight when cascadeStep hits the count, so this can read
  // true for one 5s poll before a late delivery flips it back; that errs toward
  // understating reach, which is the only safe direction to be wrong here.
  const allChannelsFailed = recipientCount > 0 && !delivered && row.cascadeStep >= recipientCount;
  return c.json(
    {
      delivered,
      channel: row.notifyChannel,
      deliveredAt: row.notifiedAt,
      status: row.status,
      closedBy: row.closedBy,
      // §3: the user's app prompts a SECOND closure request (→ guardian) when the
      // coordinator path has failed to confirm.
      coordinatorPathFailed: row.coordinatorPathFailedAt != null,
      escalationTier: row.escalationTier ?? 'coordinator',
      // §1: the truth the active screen states. 0 → "no contacts to notify,
      // recording only"; allChannelsFailed → "could not reach contacts".
      recipientCount,
      allChannelsFailed,
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

// The Durable Object that fires each contact-cascade step at its exact window
// (Brief 17) — exported so the runtime can construct it for the CASCADE_DO binding.
export { CascadeScheduler } from './cascade-do';
// Per-event WebSocket fan-out for live dashboard push (Brief 16 §4).
export { EventChannel } from './event-channel';

// fetch + scheduled (Cron Trigger). The scheduled handler runs the
// device-went-dark escalation and the vault integrity scan.
export default {
  fetch: app.fetch,
  scheduled,
};
