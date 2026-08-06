import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { hmacSha256Hex, randomHex, TRUSTED_SIGNERS, TRUST_SET_VERSION, evaluateSigner, fingerprintSpki } from '@blackbox/shared';
import { hmacAuth, sessionSecret } from './auth';
import { boundedJson, CAPTURE_PATH, check, clampArray, clampString, LIMITS, validate, validateEach } from './lib/request-bounds';
import { audit } from './lib/audit';
import { appendToChain, getChain, getChainGaps, getChainHead, hashBytes, publicKeyB64, verifyManifest } from './lib/integrity';
import { verifyChain } from './lib/chain-verdict';
import { vaultCoverage } from './lib/vault-scan';
import { credentialCoverage, verifyDeviceProof } from './lib/device-credential';
import { backoffFor, canaryExemption, environmentExemption, ruleFor, UNAUTH_OUTBOUND } from './lib/abuse-limits';
import { clearEnvironmentCache, dispatchPosture, resolveEnvironment } from './lib/environment';
import { sessionFormatShare } from './lib/session-rotation';
import { ALERT_TYPES, operatorAlert, type AlertType } from './lib/operator-alert';
import { countAttempt, outboundHeadroom, recordLimitEvent, SUSTAINED_LIMIT_THRESHOLD } from './lib/limiter-store';
import { checkPollCeiling } from './lib/poll-ceiling';
import { requestHeadroom } from './lib/request-headroom';
import { enqueueSeal, sealCoverage } from './lib/seal';
import { getCompleteness, markTerminalReceived, terminalClaimProblem } from './lib/completeness';
import { crossesTamperingThreshold, TAMPERING_WINDOW_MS } from './lib/tampering';
import {
  encryptionEnforced,
  observeChunkEncryption,
  satisfiesRequiredPolicy,
} from './lib/encryption-observed';
import {
  evaluateConsent,
  overrideTamperingClose,
  recordSupportAssent,
  recordUserAssent,
} from './lib/closure-consent';
import { broadcastEventChange } from './event-channel';
import {
  createViewSession,
  getViewSession,
  redeemViewSession,
  tokenDisposition,
  VIEW_COOKIE,
  VIEW_COOKIE_OPTS,
} from './lib/coordinator-session';
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
import {
  reissueLinkForEvent, advanceEventCascade, notifyActivation, notifyEscalation } from './lib/notify';
import { purgeOrphanedMedia } from './lib/media-purge';
import { recordRequest, routeTemplate } from './lib/route-telemetry';
import { createEnrollmentCode } from './lib/org';
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
import { handleActivationWebhook } from './routes/activation';
import { authRoutes } from './routes/auth';
import { canaryRoutes } from './routes/canary';
import { guardianRoutes } from './routes/guardians';
import { userRoutes } from './routes/user';
import { orgRoutes } from './routes/org';
import { consoleRoutes } from './routes/console';
import { orgRegisterRoutes } from './routes/org-register';
import { createOrg, recordLicense } from './lib/org';
import { createAdminRegistrationCode, reissueRegistrationCode, revokeRegistrationCode } from './lib/org-registration';
import { grantEntitlement, operatorRevokeEntitlement } from './lib/entitlement';
import { getUserByEmail, hasActiveEvent } from './lib/users';
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

/**
 * Brief 41 §A/§F — ABUSE LIMITING. Placed BEFORE any route and before any D1 read (§E4), so a
 * rejected request costs almost nothing.
 *
 * §0 — this middleware is a no-op for every path not on the explicit allow-list in
 * abuse-limits.ts. The trigger, every event-scoped write, the cascade, closure and the
 * coordinator surfaces are not on it, so they are never delayed by anything here. That is the
 * whole design: an allow-list means a NEW capture route is unlimited until somebody deliberately
 * limits it, whereas a deny-list would mean forgetting to exempt one silently throttles evidence.
 *
 * §E3 — if the counter cannot be consulted the request is ALLOWED and the condition is logged. A
 * limiter that fails closed takes down the front door for everyone.
 */
app.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const rule = ruleFor(pathname, c.req.method);
  if (!rule) return next();

  // §F — exemption is derived server-side and is never a client assertion. Staging is a separate
  // deployment severed to its own D1 and R2; the canary is `isCanary = 1` on the users row.
  const exemption = environmentExemption(c.env);
  if (exemption) {
    console.log(JSON.stringify({ limiter: 'exempt', reason: exemption, rule: rule.key, path: pathname }));
    return next();
  }

  // Per IDENTIFIER first (§E1): a DV shelter puts many survivors behind one NAT, so the origin is
  // a coarse ceiling and never the primary key. An address in the body is the identifier when one
  // is present; otherwise fall back to the origin.
  const identifier = await identifierForLimit(c);
  const attempts = countAttempt(`${rule.key}:${identifier}`, rule.windowMs);
  if (attempts === null) {
    console.log(JSON.stringify({ level: 'error', limiter: 'failed_open', rule: rule.key, path: pathname }));
    // §E3 — failing open is correct, and it must never be silent: the limiter is off for this
    // request and an operator has to know the control is not currently protecting anything.
    c.executionCtx.waitUntil(
      operatorAlert(c.env, 'limiter_store_failed_open', `limiter could not count '${rule.key}' at ${pathname} — request ALLOWED`),
    );
    return next();
  }

  const decision = backoffFor(rule, attempts);
  if (!decision.allowed) {
    // §F/§E5 — before refusing anything, check whether this is the canary. A limit that blocks the
    // canary blocks every deploy, including the one that would remove the limit. The read happens
    // HERE and not earlier so §E4 holds: the ordinary request never pays for it, and the cost
    // lands on the request that was about to be rejected.
    const canary = await canaryExemption(c.env, identifier.startsWith('email:') ? identifier.slice(6) : null);
    if (canary) {
      console.log(JSON.stringify({ limiter: 'exempt', reason: canary, rule: rule.key, path: pathname }));
      return next();
    }
    // §D — audited with identifier, origin and rule. Sustained limiting on ONE identifier is a
    // targeted attack on a specific survivor, not background noise, so it alerts at error level.
    const level = attempts > rule.burst * 4 ? 'error' : 'warn';
    console.log(
      JSON.stringify({
        level,
        limiter: 'limited',
        rule: rule.key,
        reason: rule.reason,
        attempts,
        retryAfterMs: decision.retryAfterMs,
        path: pathname,
      }),
    );
    /**
     * Brief 41 §D — SUSTAINED LIMITING, DETECTED ACROSS ISOLATES.
     *
     * The in-isolate `attempts` counter cannot carry this signal. Acceptance 12 proved it on
     * production: 26 rapid attempts against one identifier produced 16 rejections and ZERO
     * alerts, because the requests landed on several isolates and no single bucket ever passed
     * the error threshold. "A targeted attack on a specific survivor" that only fires when the
     * attacker happens to stay on one colo is not that signal.
     *
     * So a REFUSED request records itself in D1 and the count across isolates decides. The write
     * happens only after the decision to refuse, so the ordinary request still reaches no
     * database and §E4 holds — the cost lands on the attacker.
     */
    c.executionCtx.waitUntil(
      (async () => {
        const seen = await recordLimitEvent(c.env, identifier, rule.key, rule.windowMs);
        if (seen != null && seen === SUSTAINED_LIMIT_THRESHOLD) {
          // Exactly AT the threshold, so one attack raises one alert rather than one per request
          // past it. Everything after is collapsed by the channel's own window anyway, but this
          // keeps the D1 write cheap and the signal legible.
          await operatorAlert(
            c.env,
            'sustained_rate_limiting',
            `${seen} refused attempts against rule '${rule.key}' for a single identifier at ${pathname} within ${Math.round(rule.windowMs / 60000)} minutes — ${rule.reason}`,
          );
        }
      })(),
    );
    return c.json({ error: 'slow_down', retryAfterMs: decision.retryAfterMs }, 429, {
      'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)),
    });
  }
  return next();
});

/**
 * The limit key. Prefers a stable identifier over the origin so that many survivors behind one
 * shelter NAT are counted separately (§E1). Reads the body without consuming it.
 */
async function identifierForLimit(c: { req: { raw: Request; header: (k: string) => string | undefined } }): Promise<string> {
  const origin = c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for') ?? 'unknown-origin';
  try {
    const clone = c.req.raw.clone();
    const body = (await clone.json().catch(() => null)) as { email?: string; code?: string } | null;
    const email = (body?.email ?? '').trim().toLowerCase();
    if (email) return `email:${email}`;
  } catch {
    /* not JSON, or already consumed — the origin is a correct fallback */
  }
  return `origin:${origin}`;
}

/**
 * Brief 42 §B/§D — SECURITY HEADERS ON THE WORKER, not only on Pages.
 *
 * `_headers` is a Cloudflare Pages file and applies to the PWA origin only. The Worker serves the
 * COORDINATOR DASHBOARD, and its URL carries an event-bound magic token — so the one origin whose
 * referrer actually matters was the one with no referrer policy at all. Any link a coordinator
 * clicked from that page would have sent the token-bearing URL to wherever they went.
 *
 * `no-referrer` rather than `strict-origin-when-cross-origin`: the token is in the PATH, and a
 * policy that emits an origin still emits nothing useful here while a policy that emits a path
 * emits the token. There is no middle setting worth having.
 *
 * DELIBERATELY NOT A CSP. The dashboard renders inline script, so a strict policy needs nonces,
 * and the dashboard is ON the alert path — a coordinator who cannot see an alert is the failure
 * this product exists to prevent. That is §A's report-only-then-enforce process, and it is not
 * this brief's §D requirement. These three headers cannot break a render.
 */
/**
 * §A — the ordinary-route body bound, applied at one seam.
 *
 * Routes on the CAPTURE PATH are exempt here and carry their own bounds, which clamp instead of
 * refusing. That asymmetry is the point: this middleware's job is to refuse, and refusing is the
 * wrong answer for a device uploading evidence mid-incident.
 *
 * The exemption is a pattern rather than a list of literal paths so a new `/v1/events/:id/...`
 * ingest route inherits it, and `request-bounds.guard.test.ts` asserts that every capture route
 * actually present in this file matches — because the failure mode of getting that wrong is a
 * survivor's upload rejected for being 64 KB, which is exactly the harm the split exists to
 * prevent.
 */
// Defined in request-bounds.ts, not here, so the guard test asserts the SAME value this
// middleware uses. A copy in the test would have passed while this one was wrong.

app.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
  const pathname = new URL(c.req.url).pathname;
  if (CAPTURE_PATH.test(pathname)) return next(); // bounded at the route, by clamping
  const declared = Number(c.req.header('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > LIMITS.jsonBodyBytes) {
    return c.json({ ok: false, error: 'body_too_large', limitBytes: LIMITS.jsonBodyBytes }, 413);
  }
  return next();
});

app.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
});

// Structured request logging — no payload contents.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  await next();
  // Brief 58 — the same facts, to a store that RETAINS them. The console.log below goes to a
  // stream nothing keeps, which is why a million requests against one route left no trace and
  // took a week to attribute. Route template only: no token, no event id, no user, no body.
  recordRequest(
    c.env,
    routeTemplate(new URL(c.req.url).pathname),
    c.res.status,
    c.req.method,
    Date.now() - start,
  );
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

// Brief 30 §1 — the PUBLISHED report-verification key. Deliberately a different key from the
// integrity key above: that one signs custody export manifests for a named recipient, this
// one signs survivor reports that go to courts and strangers.
//
// Published unconditionally and without auth, because the whole point is that a court's own
// expert can verify a report WITHOUT this server and without the verification page. This
// endpoint is NOT flag-gated: publishing a public key commits to nothing and reveals nothing,
// and a report signed today must stay checkable years from now.
/**
 * Brief 39 §0 — the trust set, served for ROTATION DISCOVERY ONLY.
 *
 * This endpoint is NOT authority. The verifier embeds the same set at build time and that
 * embedded copy decides; this exists so an operator (or a reviewer holding an older verifier)
 * can see that a key has been added, retired or revoked, and go and check. Treating a fetched
 * list as authority would put trust back in the network, which is the shape of the defect
 * this brief closes — just one layer further out.
 *
 * Everything here is already public: these keys are published, embedded in the standalone
 * verifier, and served at the well-known endpoints. Nothing secret is exposed.
 */
app.get('/.well-known/blackbox-trust-roots.json', async (c) => {
  return c.json(
    {
      version: TRUST_SET_VERSION,
      note: 'Rotation discovery only. The verifier embeds this set; the embedded copy is authoritative.',
      keys: TRUSTED_SIGNERS.map((k) => ({
        fingerprint: k.fingerprint,
        algorithm: k.algorithm,
        role: k.role,
        label: k.label,
        environment: k.environment,
        validFrom: k.validFrom,
        validUntil: k.validUntil,
        revokedAt: k.revokedAt,
        revokedReason: k.revokedReason,
        spki: k.spki,
      })),
    },
    200,
  );
});

app.get('/.well-known/blackbox-report-public-key.json', async (c) => {
  const publicKey = c.env.REPORT_PUBLIC_KEY;
  if (!publicKey) {
    return c.json({ error: 'no_report_key' }, 503);
  }
  return c.json(
    {
      algorithm: 'ECDSA',
      curve: 'P-256',
      hash: 'SHA-256',
      signatureFormat: 'raw-r||s (P1363), base64',
      format: 'spki-base64',
      publicKey,
      specification: 'https://github.com/rparfait01/blackbox/blob/master/docs/brief29/VERIFICATION.md',
    },
    200,
  );
});

// Convenience verifier: POST a signed export manifest, get back whether its
// Ed25519 signature checks out against the manifest's published key. Stateless,
// no auth, never throws — verification is a public, reproducible operation.
app.post('/v1/integrity/verify', async (c) => {
  // §A/§C — unauthenticated and public, so it is the most exposed body on the API. Bounded and
  // depth-limited like every other, and the refusal is named rather than collapsed into a single
  // `invalid_json` that cannot distinguish a typo from a 10 MB nesting bomb.
  const read = await boundedJson<Record<string, unknown>>(c.req, LIMITS.jsonBodyBytes);
  if (read.value === null) {
    return c.json({ valid: false, error: read.refusal ?? 'invalid_json' }, read.refusal === 'too_large' ? 413 : 400);
  }
  const valid = await verifyManifest(read.value);
  return c.json({ valid }, 200);
});

// --- Brief 29 §3: the public certified-report verification page. A LEAF.
//
// Nothing in the running system imports this, routes through it, or waits on it. Deleting
// the page leaves BLACK BOX unchanged and documents independently verifiable by the
// published key — the page is a convenience, the mathematics is the trust.
//
// The visitor's file is NEVER uploaded: the page inlines the shared verifier and checks the
// document in the browser. There is no upload endpoint here to store anything with, which
// is why "the verifier never stores the uploaded document" needs no one's trust.
//
// DARK until zero-knowledge custody is armed. With the flag down no certified report can
// exist, so publishing a verification promise (and pinning a key to it) would be a public
// commitment to a thing that cannot yet happen. It 404s until there is something to verify.
app.get('/verification', async (c) => {
  if (c.env.ENVELOPE_ENCRYPTION_ENABLED !== 'true') {
    return c.notFound();
  }
  const publicKey = publicKeyB64(c.env);
  if (!publicKey) {
    return c.notFound(); // no published key ⇒ nothing could be verified against it
  }
  const { verificationPage } = await import('./lib/verification-page');
  const { VERIFIER_BUNDLE } = await import('./generated/verifier-bundle');
  return c.html(verificationPage(publicKey, VERIFIER_BUNDLE));
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
      // Brief 57 — revocation follows this write; see revokeEventCredentials.
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
  const body = ((await boundedJson<OpenEventBody>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as OpenEventBody));
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
    ? await c.env.DB.prepare('SELECT orgId, isCanary FROM users WHERE id = ?')
        .bind(userId)
        .first<{ orgId: string | null; isCanary: number }>()
    : null;
  const orgId = owner?.orgId ?? null;

  // Brief 35 §C — `isTest` is DERIVED HERE, from the owning account, and from nowhere
  // else. The request body is not consulted: `body` has no isTest field, and adding one
  // would change nothing, because this line is the only thing that writes the column.
  // A tokenless (covert) trigger has no account and is therefore never a test — which is
  // the right default, since that is the path a survivor uses when they cannot sign in.
  const isTest = Number(owner?.isCanary ?? 0) === 1 ? 1 : 0;

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
      'INSERT INTO events (id, createdAt, status, userHash, userId, orgId, hmacSecret, source, locale, tzOffsetMinutes, lastHeartbeatAt, isTest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        isTest,
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
// Brief 34 §1 — there is NO consumer-mint webhook any more. The buyer's Gumroad LICENCE
// KEY is the access code, verified server-to-server against Gumroad at signup. That
// removed the unsigned-Ping problem (Gumroad's native Ping cannot be HMAC-verified, so a
// fail-closed webhook rejected every real sale) and removed a delivery that could bounce,
// be spam-filtered, or be suppressed — a buyer could pay and receive nothing. See
// lib/gumroad-license.ts.
// Brief 24 — org admin registration at its OWN base path (distinct from the
// session-gated /v1/org portal group): the public read-only GET /v1/org-register/:code
// is reachable without a session; the completion POST applies requireSession itself.
app.route('/v1/org-register', orgRegisterRoutes);
// Brief 23 — the org portal surface. Every route inside is session + org-role gated
// and scoped to the caller's own org; individual accounts never reach it.
app.route('/v1/org', orgRoutes);

// Brief 33b — THE CONSOLE. One surface, four levels (operator / admin / coordinator /
// unmarked), every one of them decided SERVER-SIDE per request from the session. It is
// registered as its own router rather than folded into /v1/org because its scope rule is
// different in kind: /v1/org is always exactly one org, while the console must also serve
// the one role that legitimately crosses orgs. Nothing inside can read incident content.
app.route('/v1/console', consoleRoutes);

// --- Admin (pilot-only; Bearer ADMIN_TOKEN). Onboarding moves to W9. ---
// Brief 33a — TWO ways to be the operator, and the difference matters.
//
//   ADMIN_TOKEN  — a bearer secret. Kept for scripts, CI, and the acceptance suite, which
//                  have no session and no person behind them.
//   OPERATOR SESSION — an account whose users.platform_role = 'operator'. This is what the
//                  console uses, so an operator never pastes a token into a browser, and
//                  every action they take is ATTRIBUTABLE to a person rather than to
//                  whoever holds a secret.
//
// The token path is checked first because it is a constant-time string compare with no DB
// hit; the session path costs a lookup and only runs when there is no matching token.
// Either satisfies the gate — neither weakens it, because both are all-or-nothing and
// there is no third way in.
app.use('/v1/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const provided = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');

  let authorized = !!expected && provided === expected;
  let actorUserId: string | null = null;

  if (!authorized && provided) {
    // Not the token — try it as a session belonging to an operator account.
    const secret = sessionSecret(c.env);
    const session = secret ? await verifySession(secret, provided) : null;
    if (session?.userId) {
      const row = await c.env.DB.prepare('SELECT platform_role FROM users WHERE id = ?')
        .bind(session.userId)
        .first<{ platform_role: string | null }>();
      if (row?.platform_role === 'operator') {
        authorized = true;
        actorUserId = session.userId;
      }
    }
  }

  if (!authorized) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Downstream handlers audit with this, so an operator action names the operator.
  c.set('operatorUserId', actorUserId);
  await next();
  return undefined;
});

// Brief 35 §C — the deploy canary's control surface (provision / status / purge).
//
// REGISTERED HERE, AFTER THE GATE ABOVE, AND THAT ORDER IS THE AUTHORISATION. Hono runs
// matching handlers in REGISTRATION order, so a router mounted before the `/v1/admin/` prefix
// middleware would answer the request itself and the gate would never execute. Mounting
// it after means every route inside is reached only through ADMIN_TOKEN or an operator
// session, with no authorisation rule of its own to drift — a second way in is a second
// way in, however well-intentioned. Nothing in the PWA calls any of it.
app.route('/v1/admin/canary', canaryRoutes);

/**
 * ENCRYPTION READINESS — Brief 36, operator amendment 2. Plain language, no interpretation
 * required.
 *
 * WHY THIS EXISTS AND WHY IT IS WORDED LIKE THIS. ENVELOPE_ENCRYPTION_ENABLED was set to
 * "true" on 2026-07-30 and the system was described from then on as encryption-armed. It
 * had encrypted nothing: 62 chunks stored, 0 wrapped keys, 0 commitments, 0 accounts with a
 * public key. Nothing anywhere said so, because the only signal was a flag that reported
 * its own intent rather than the world.
 *
 * So this reports the WORLD — counted from the tables, every time it is asked — and it
 * leads with the enforcement state in the words an operator would use. Dark is fine. Dark
 * while believing otherwise is what cost this product two months of imaginary encryption.
 */
/**
 * §E — THE POLICY SURFACE. Relaxing encryption for an account is an explicit operator
 * decision with a name on it, never a silent runtime fallback.
 *
 * The distinction this enforces is the whole point of the section: the system may end up
 * storing plaintext for an account, but only because a person decided so, on the record,
 * with a reason — not because some code path quietly gave up. A REQUIRED account that
 * cannot encrypt declares itself (FAILED_TERMINAL) and alerts; it does not silently become
 * a RELAXED one.
 */
app.post('/v1/admin/encryption/policy', async (c) => {
  const body = ((await boundedJson<{ email?: string; policy?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { email?: string; policy?: string; reason?: string }));
  const email = (body.email ?? '').trim().toLowerCase();
  const policy = body.policy === 'RELAXED' ? 'RELAXED' : body.policy === 'REQUIRED' ? 'REQUIRED' : null;
  const reason = (body.reason ?? '').trim();
  if (!email || !policy) {
    return c.json({ error: 'email_and_policy_required', policy: 'REQUIRED | RELAXED' }, 400);
  }
  // A reason is MANDATORY for relaxation. "Why is this account storing plaintext?" must
  // always have an answer, and an operator who cannot articulate one should not proceed.
  if (policy === 'RELAXED' && reason.length < 8) {
    return c.json({ error: 'reason_required', message: 'Relaxing encryption requires a stated reason.' }, 400);
  }
  const user = await c.env.DB.prepare('SELECT id, encryptionPolicy FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string; encryptionPolicy: string }>();
  if (!user) {
    return c.json({ error: 'not_found' }, 404);
  }
  await c.env.DB.prepare('UPDATE users SET encryptionPolicy = ?, updatedAt = ? WHERE id = ?')
    .bind(policy, Date.now(), user.id)
    .run();
  // Actor, timestamp and reason, in one row. The timestamp is the audit row's own.
  await audit(c.env, null, 'encryption.policy_changed', c.get('operatorUserId') ?? 'admin_token', {
    userId: user.id,
    from: user.encryptionPolicy,
    to: policy,
    reason,
  });
  if (policy === 'RELAXED') {
    console.log(
      JSON.stringify({
        level: 'warn',
        alert: 'encryption_policy_relaxed',
        message: 'an account was moved off REQUIRED encryption by an operator',
        userId: user.id,
        reason,
      }),
    );
  }
  return c.json({ ok: true, userId: user.id, from: user.encryptionPolicy, to: policy, reason }, 200);
});

/**
 * §C — record a key rotation or revocation as an OPERATOR ACTION: actor, timestamp, reason.
 *
 * IT DOES NOT CHANGE WHAT IS TRUSTED, and that is deliberate. The trust set lives in
 * version-controlled source (packages/shared/src/trust-roots.ts) so that widening it is a
 * reviewed code change with a visible diff. An endpoint that could add a trusted key would be
 * a dynamic path to widening trust — exactly what §A forbids. This writes the operational
 * record; the code change is the enforcement, and the two are expected to agree.
 */
app.post('/v1/admin/trust/record', async (c) => {
  const body = ((await boundedJson<{ fingerprint?: string; action?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { fingerprint?: string; action?: string; reason?: string }));
  const fingerprint = (body.fingerprint ?? '').trim();
  const action = body.action === 'rotate' || body.action === 'revoke' ? body.action : null;
  const reason = (body.reason ?? '').trim();
  if (!fingerprint || !action || reason.length < 8) {
    return c.json(
      { error: 'fingerprint_action_reason_required', action: 'rotate | revoke' },
      400,
    );
  }
  const known = TRUSTED_SIGNERS.find((k) => k.fingerprint === fingerprint) ?? null;
  await audit(c.env, null, `trust.key_${action}`, c.get('operatorUserId') ?? 'admin_token', {
    fingerprint,
    reason,
    knownInTrustSet: !!known,
    trustSetVersion: TRUST_SET_VERSION,
  });
  console.log(
    JSON.stringify({
      level: 'warn',
      alert: `trust_key_${action}`,
      fingerprint,
      reason,
      knownInTrustSet: !!known,
    }),
  );
  return c.json(
    {
      ok: true,
      recorded: action,
      fingerprint,
      knownInTrustSet: !!known,
      trustSetVersion: TRUST_SET_VERSION,
      note: 'Recorded only. Update packages/shared/src/trust-roots.ts to change what is actually trusted.',
    },
    200,
  );
});

/**
 * Brief 35 Fix B §A — STAMP THIS DATABASE.
 *
 * The environment marker lives in the database the binding points at, so a Worker wired to
 * blackbox-test reads 'staging' regardless of its vars, hostname or deploy command. It is set
 * here rather than by a migration because a shared migration runs identically against both
 * databases and could only write the same answer into each — a configured value in a migration's
 * clothing.
 *
 * Stamping is idempotent and re-stamping is allowed, audited, and immediately visible: the
 * per-isolate cache is cleared so a correction does not wait for a deploy.
 */
app.post('/v1/admin/environment/stamp', async (c) => {
  const body = ((await boundedJson<{ name?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { name?: string }));
  const name = (body.name ?? '').trim().toLowerCase();
  if (!name || !/^[a-z][a-z0-9_-]{1,30}$/.test(name)) {
    return c.json({ error: 'name must be a short lowercase identifier, e.g. production or staging' }, 400);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO environment_identity (id, name, stampedAt, stampedBy) VALUES (1, ?, ?, 'admin')
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, stampedAt = excluded.stampedAt`,
  )
    .bind(name, now)
    .run();
  clearEnvironmentCache();
  const identity = await resolveEnvironment(c.env);
  await audit(c.env, null, 'environment.stamped', null, { name, verdict: identity.verdict });
  return c.json({ ok: true, ...identity }, 200);
});

/**
 * Brief 35 Fix B §D acceptance 8/9 — FIRE THE CHANNEL AND SEE WHETHER IT ARRIVES.
 *
 * An alert channel that has never been exercised is an assumption, and this brief exists because
 * assumptions about alerting were wrong for eight briefs running. This is the operator tool that
 * turns "the code looks right" into "an email landed": admin-gated, restricted to the declared
 * alert types, and it reports exactly what the channel did with each one.
 *
 * `count` exists to prove §D's storm behaviour: the first fires, the rest are counted, and the
 * cron reports the window with its first and last. Bounded so this cannot itself become a storm.
 */
app.post('/v1/admin/alerts/test', async (c) => {
  const body = ((await boundedJson<{ type?: string; count?: number }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { type?: string; count?: number }));
  const type = (body.type ?? '') as AlertType;
  if (!ALERT_TYPES.includes(type)) {
    return c.json({ error: 'unknown alert type', known: ALERT_TYPES }, 400);
  }
  const count = Math.min(Math.max(Number(body.count ?? 1), 1), 25);
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(await operatorAlert(c.env, type, `acceptance probe ${i + 1} of ${count} for ${type}`));
  }
  return c.json(
    {
      type,
      fired: count,
      sentImmediately: results.filter((r) => r.sent).length,
      countedIntoWindow: results.filter((r) => !r.sent && r.counted).length,
      first: results[0],
      last: results[results.length - 1],
    },
    200,
  );
});

/** The open alert windows, so acceptance can read what the channel is holding. */
app.get('/v1/admin/alerts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT alertType, windowStart, firstAt, lastAt, count, notifiedAt, summarisedAt FROM operator_alerts ORDER BY windowStart DESC, alertType ASC LIMIT 50',
  ).all();
  return c.json({ windows: results ?? [] }, 200);
});

/** The stamp as this Worker reads it — used by the deploy gate to prove production can dispatch. */
app.get('/v1/admin/environment', async (c) => c.json(await dispatchPosture(c.env), 200));

app.get('/v1/admin/encryption/readiness', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE isCanary = 0) AS accounts,
       (SELECT COUNT(*) FROM users WHERE isCanary = 0 AND pubkey IS NOT NULL AND pubkey <> '') AS withKeys,
       (SELECT COUNT(*) FROM users WHERE isCanary = 0 AND encryptionPolicy = 'REQUIRED') AS policyRequired,
       (SELECT COUNT(*) FROM chunks_index WHERE encryptionState = 'ENCRYPTED') AS encryptedChunks,
       (SELECT COUNT(*) FROM chunks_index WHERE encryptionState = 'UNENCRYPTED_DECLARED') AS declaredPlaintextChunks,
       (SELECT COUNT(*) FROM chunks_index WHERE encryptionState = 'UNENCRYPTED_UNDECLARED') AS undeclaredPlaintextChunks,
       (SELECT COUNT(*) FROM wrapped_keys) AS wrappedKeys`,
  ).first<{
    accounts: number;
    withKeys: number;
    policyRequired: number;
    encryptedChunks: number;
    declaredPlaintextChunks: number;
    undeclaredPlaintextChunks: number;
    wrappedKeys: number;
  }>();
  const enforced = encryptionEnforced(c.env);
  // Brief 40 §A/§12 — vault coverage, reported the same way encryption is: counted from the
  // tables, next to the claim, so partial coverage cannot hide behind a job that merely ran.
  const vault = await vaultCoverage(c.env);
  const devices = await credentialCoverage(c.env);
  const outbound = await outboundHeadroom(c.env, UNAUTH_OUTBOUND.windowMs, UNAUTH_OUTBOUND.max);
  const dispatch = await dispatchPosture(c.env);
  const sessions = await sessionFormatShare(c.env);
  // §F7 — sealing coverage: pending, failures, and the oldest closed-but-unsealed event.
  const seal = await sealCoverage(c.env);
  // §F — request headroom. The Worker IS the alert path, so a billing threshold is an
  // outage threshold; it belongs on the panel that reports what is true.
  const headroom = await requestHeadroom(c.env);
  const plaintext = Number(row?.declaredPlaintextChunks ?? 0) + Number(row?.undeclaredPlaintextChunks ?? 0);
  return c.json(
    {
      // The headline, in the operator's own words. Read this and nothing else and you
      // still know whether the product is protecting anything.
      summary:
        `ENCRYPTION: ${enforced ? 'ENFORCED' : 'NOT ENFORCED'}` +
        ` · ${Number(row?.accounts ?? 0)} accounts` +
        ` · ${Number(row?.withKeys ?? 0)} with keys` +
        ` · ${plaintext} plaintext chunks stored`,
      enforced,
      // The flag says what was INTENDED; the counts say what is TRUE. Both, side by side,
      // because the gap between them is the whole story.
      envelopeFlag: c.env.ENVELOPE_ENCRYPTION_ENABLED === 'true',
      accounts: Number(row?.accounts ?? 0),
      accountsWithKeys: Number(row?.withKeys ?? 0),
      accountsPolicyRequired: Number(row?.policyRequired ?? 0),
      chunks: {
        encrypted: Number(row?.encryptedChunks ?? 0),
        plaintextDeclared: Number(row?.declaredPlaintextChunks ?? 0),
        plaintextUndeclared: Number(row?.undeclaredPlaintextChunks ?? 0),
      },
      wrappedKeys: Number(row?.wrappedKeys ?? 0),
      // Brief 2 Fix A acceptance 10 — per-account credential coverage, stated as counts so the
      // accounts still accepting userHash are visible rather than rounded away.
      devices,
      // Brief 41 §C — outbound quota headroom, beside the request headroom from Brief 33 Fix A §F.
      outbound,
      // Brief 35 Fix B §C — per-environment dispatch state and provider-credential presence. A
      // non-production row showing both is an alertable condition.
      dispatch,
      // Brief 42 §C — legacy-format share, so retiring the old token shape is a decision made
      // with data. Observed on use, never a census: sessions are stateless and cannot be listed.
      sessions,
      vault: {
        // Brief 37 Fix A — an EMPTY vault does not report as a verified one. "0/0 objects
        // verified" reads as healthy, and for two months it was the literal truth of a vault
        // that had never sealed anything: five closed events, zero objects, a panel saying
        // nothing was wrong. An empty set is not evidence of integrity, it is the absence of
        // evidence, and the panel has to say which one it is looking at.
        summary:
          (vault.eligible === 0
            ? 'VAULT: EMPTY — no sealed objects exist to verify'
            : `VAULT: ${vault.verified}/${vault.eligible} objects verified`) +
          ` · pass ${vault.passNumber}${vault.passInFlight ? ' (in flight)' : ''}` +
          `${vault.lastPassBacklog > 0 ? ` · BACKLOG ${vault.lastPassBacklog}` : ''}`,
        ...vault,
        // §D — what the retention CLAIM currently rests on. Stated here because the panel is
        // the one place that reports what is true rather than what was intended.
        // Brief 40 §B/§C/§D. The Workers runtime cannot read R2 lock rules from a binding, so
        // this states what is PROVISIONED and names where it is VERIFIED, rather than implying
        // the Worker checked it. The deploy gate reads the live rule back on every deploy and
        // refuses to publish if it is absent, mis-scoped, disabled, shortened or indefinite.
        //
        // The wording is §D-bound on purpose: this rule binds the OPERATOR. It is not
        // "write-once", it does not make objects immutable against the account holder, and it
        // does not survive removal of the rule, the bucket, the account, or the billing
        // relationship. Capture media in blackbox-media is deliberately NOT covered, which is
        // what keeps an owner-consented purge possible.
        retentionRule:
          'blackbox-vault vault/ — 1096 days (36 months), operator-binding. Verified at deploy ' +
          'from infra/r2/blackbox-vault.lock.json. Not write-once: removable by the account holder.',
      },
      requests: headroom,
      sealing: {
        summary:
          `SEALING: ${seal.sealedTotal} sealed · ${seal.pending} pending` +
          `${seal.failed > 0 ? ` · ${seal.failed} FAILING` : ''}` +
          `${seal.closedUnsealed > 0 ? ` · ${seal.closedUnsealed} closed-and-unsealed` : ''}`,
        ...seal,
      },
      // Said explicitly so it cannot be inferred wrongly from a green-looking panel.
      claim: enforced
        ? 'Capture encryption is enforced for REQUIRED accounts.'
        : 'Capture is NOT encrypted. No document may state otherwise until Brief 47 is green.',
    },
    200,
  );
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
  const body = ((await boundedJson<AdminContactBody>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as AdminContactBody));
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
  const body = ((await boundedJson<{ name?: string; lane?: string; seatsTotal?: number; termStart?: number; termEnd?: number }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { name?: string; lane?: string; seatsTotal?: number; termStart?: number; termEnd?: number }));
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
  const body = ((await boundedJson<{ reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { reason?: string }));
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return c.json({ error: 'reason required (this is a logged privileged action)' }, 400);
  }
  const fresh = await reissueRegistrationCode(c.env, orgId, reason, null);
  return c.json({ registrationCode: fresh.code, registrationExpiresAt: fresh.expiresAt }, 201);
});

app.post('/v1/admin/orgs/:orgId/registration-code/revoke', async (c) => {
  const body = ((await boundedJson<{ code?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { code?: string; reason?: string }));
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

// Brief 28 §4 — operator entitlement grant (source operator_grant). Entitlement ONLY:
// it never touches org membership or seats (those are the enrollment/registration
// paths). Idempotent + logged. For the account bought out-of-band, comped, or recovered
// from an orphaned web receipt. Target by email or userId.
app.post('/v1/admin/entitlement/grant', async (c) => {
  const body = ((await boundedJson<{ email?: string; userId?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { email?: string; userId?: string; reason?: string }));
  const userId = body.userId?.trim() || (body.email ? (await getUserByEmail(c.env, body.email))?.id : undefined);
  if (!userId) {
    return c.json({ error: 'account_not_found' }, 404);
  }
  const result = await grantEntitlement(c.env, userId, 'operator_grant');
  await audit(c.env, null, 'admin.entitlement_grant', null, { targetUserId: userId, reason: (body.reason ?? '').trim() || null });
  return c.json({ ok: true, userId, activated: result.activated, alreadyActive: result.alreadyActive }, 200);
});

// Brief 28 §4 — the ONE revoke path (manual, fraud-only, logged). No automatic revoke
// exists anywhere: no chargeback hook, no license-expiry sweep. A reason is REQUIRED
// (this deactivates a survivor's arm affordance — a privileged, audited action).
app.post('/v1/admin/entitlement/revoke', async (c) => {
  const body = ((await boundedJson<{ email?: string; userId?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { email?: string; userId?: string; reason?: string }));
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return c.json({ error: 'reason required (this is a logged privileged action)' }, 400);
  }
  const userId = body.userId?.trim() || (body.email ? (await getUserByEmail(c.env, body.email))?.id : undefined);
  if (!userId) {
    return c.json({ error: 'account_not_found' }, 404);
  }
  // Never strip protection from someone actively being protected (§0 principle, same as
  // a lapsed org license). Revoke is refused while the account has a LIVE alert — even
  // though revoke would only affect the ARM affordance, not the open event or the trigger
  // (both stay live), yanking entitlement mid-alert is exactly the case this must not do.
  // Retry once the alert is closed.
  if (await hasActiveEvent(c.env, userId)) {
    return c.json({ error: 'active_event', message: 'Cannot revoke while the account has a live alert. Retry after it closes.' }, 409);
  }
  const changed = await operatorRevokeEntitlement(c.env, userId, reason, null);
  return c.json({ ok: true, userId, changed }, 200);
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
  const body = ((await boundedJson<{ resolution?: string; cooperated?: boolean }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { resolution?: string; cooperated?: boolean }));
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
// --- Code issuance (Bearer ADMIN_TOKEN) — Brief 30 §C, the INSTITUTIONAL path.
//
// This is the DV-shelter route: an operator mints codes and hands them to an organisation
// (or, with source=consumer, replaces a buyer's lost code). It touches NO payment provider
// and shares no code path with the Gumroad webhook — the only thing the two have in common
// is the ONE generator, which is the point of the unified model (§B).
app.post('/v1/admin/codes/issue', async (c) => {
  const body = ((await boundedJson<{ count?: number; orgId?: string; org_id?: string; role?: string; source?: string; maxUses?: number; expiresAt?: number }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as Record<string, never>));
  const count = Math.max(1, Math.min(Number(body.count ?? 1) || 1, 500));
  const orgId = (body.orgId ?? body.org_id ?? '').trim() || null;
  const source = body.source === 'consumer' ? 'consumer' : orgId ? 'institutional' : 'consumer';
  const role =
    body.role === 'coordinator' || body.role === 'admin' ? body.role : 'survivor';

  // The model's invariant, surfaced as a clear 400 rather than a DB CHECK failure.
  if (source === 'institutional' && !orgId) {
    return c.json({ error: 'orgId_required_for_institutional' }, 400);
  }
  if (source === 'consumer' && orgId) {
    return c.json({ error: 'consumer_codes_carry_no_org' }, 400);
  }

  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await createEnrollmentCode(c.env, {
      orgId: source === 'institutional' ? orgId : null,
      source,
      role,
      maxUses: typeof body.maxUses === 'number' && body.maxUses > 0 ? body.maxUses : 1,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
      createdBy: 'operator',
    });
    codes.push(row.code);
  }
  await audit(c.env, null, 'admin.codes_issued', null, { count: codes.length, source, orgId, role });
  return c.json({ ok: true, source, orgId, role, codes }, 201);
});

// --- Orphaned-capture purge (Bearer ADMIN_TOKEN). Clears R2 residue by IDENTITY, not
// by a lifecycle rule. A lifecycle rule CANNOT express "never delete a new capture" —
// --expire-date kills them at once, --expire-days N kills them N days later, and prefix
// scoping cannot separate old from new because keys carry a UUID, not a timestamp. A
// standing rule that eventually eats live captures is a suspended safety guarantee.
//
// This deletes only objects that are BOTH older than the cutoff taken at invocation AND
// unreferenced by chunks_index, and it leaves nothing behind: when it finishes, no rule
// anywhere is scheduled to delete anything.
//
// DRY RUN BY DEFAULT — pass {"confirm": true} to actually delete. Resumable: re-invoke
// while `done` is false.
app.post('/v1/admin/media/purge-orphans', async (c) => {
  const body = ((await boundedJson<{ confirm?: boolean; maxObjects?: number }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { confirm?: boolean; maxObjects?: number }));
  const result = await purgeOrphanedMedia(c.env, {
    confirm: body.confirm === true,
    maxObjects: typeof body.maxObjects === 'number' ? body.maxObjects : undefined,
  });
  // Audited: a mass storage deletion is an operator action and leaves a record.
  if (!result.dryRun) {
    await audit(c.env, null, 'admin.media_purge', null, {
      deleted: result.deleted,
      scanned: result.scanned,
      skippedTooNew: result.skippedTooNew,
      skippedReferenced: result.skippedReferenced,
      done: result.done,
    });
  }
  return c.json(result, 200);
});

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
  const body = ((await boundedJson<{ reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { reason?: string }));
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
    // Brief 57 — revocation follows this write; see revokeEventCredentials.
    'UPDATE events SET status = ?, closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ?, reasonSecured = ? WHERE id = ? AND status = ?',
  )
    .bind('closed', now, 'operator_force_close', now, 'operator', reason, eventId, 'active')
    .run();
  // §F1 — an operator force-close is a terminal state like any other.
  await enqueueSeal(c.env, eventId, 'force_close');
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
    // `via` (cascade_fired only) names the driver that actually fired the step —
    // alarm | cron | stagger | heartbeat. Surfaced so the acceptance suite can tell
    // a precise Durable-Object schedule from a cron-rescued one, which timestamps
    // alone cannot distinguish.
    let via: string | undefined;
    try {
      const meta = r.metadataJson ? (JSON.parse(r.metadataJson) as { step?: number; via?: string }) : null;
      step = meta?.step;
      via = meta?.via;
    } catch {
      step = undefined;
      via = undefined;
    }
    return { timestamp: r.timestamp, action: r.action, step, via };
  });
  return c.json({ rows }, 200);
});

/**
 * Brief 37 §E — the chain's verdict for one event, recomputed from the stored records rather
 * than read from anything cached. Admin-only observability: the same function the export
 * manifest embeds, so what an operator sees and what a court's verifier sees cannot diverge.
 */
app.get('/v1/admin/events/:id/chain', async (c) => {
  const eventId = c.req.param('id');
  // Brief 39 §D — the FOURTH axis. The custody manifest is signed with the integrity key;
  // report which published key that is, by fingerprint, from the set we hold.
  const integritySigner = await (async () => {
    const spki = publicKeyB64(c.env);
    if (!spki) return null;
    const fp = await fingerprintSpki(spki);
    return evaluateSigner({ fingerprint: fp, signatureValid: true, signedAt: Date.now(), role: 'integrity' });
  })();
  const [verdict, records, gaps, head, completeness] = await Promise.all([
    verifyChain(c.env, eventId),
    getChain(c.env, eventId),
    getChainGaps(c.env, eventId),
    getChainHead(c.env, eventId),
    getCompleteness(c.env, eventId),
  ]);
  return c.json(
    {
      verdict,
      // Brief 38 — the SECOND axis. Chain integrity and capture completeness are independent
      // findings and are reported separately; a purged capture keeps the completeness state
      // it held at purge.
      completeness,
      // Brief 39 — the FOURTH axis: who vouches for this deployment's signatures, named by
      // fingerprint against a trust set held independently of any package.
      signer: integritySigner,
      trustSetVersion: TRUST_SET_VERSION,
      head: head ? { seq: head.seq, chainHead: head.chainHead } : null,
      recordCount: records.length,
      sequences: records.map((r) => r.seq),
      gaps,
    },
    200,
  );
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
// Brief 28 §3: web-purchase activation. Public + fail-closed — authenticated ENTIRELY
// by the HMAC signature, never a session or a client claim (no client-granted
// entitlement, ever). 401s when the secret is unset or the signature is wrong.
app.post('/v1/activation/webhook', handleActivationWebhook);

// --- Contact magic-link view (no login; the signed token is the auth) ---
/**
 * The resolved caller on the /v1/c/ path: which role, and how they proved it.
 *
 * Returned rather than reduced to a boolean because some routes need the ROLE — the coordinator
 * claim must exclude the authority/dispatch path. Before this fix that route read the token and
 * called `verifyTokenRole` itself, which is how it missed the cookie: a second verification path
 * drifts from the first, and the drift was invisible until it was a live P0.
 */
interface MagicCaller {
  role: 'guardian' | 'dispatch' | 'notified' | 'coordinator';
  via: 'cookie' | 'token';
}

/**
 * THE shared verification for the /v1/c/ path. Every route on it goes through this — there is no
 * second path, by construction: `resolveMagicCaller` is the only caller of `verifyTokenRole`
 * outside the token/cookie EXCHANGE in `GET /c/:id`.
 */
async function resolveMagicCaller(c: AppContext): Promise<MagicCaller | null> {
  const eventId = c.req.param('id') ?? '';

  const viewSession = await getViewSession(c.env, getCookie(c, VIEW_COOKIE) ?? '', eventId);
  const caller: MagicCaller | null = viewSession
    ? { role: (viewSession.role as MagicCaller['role']) ?? 'guardian', via: 'cookie' }
    : await (async (): Promise<MagicCaller | null> => {
        const secret = c.env.MAGIC_LINK_SECRET;
        if (!secret) return null;
        const token = c.req.query('t') ?? '';
        const { verdict, role } = await verifyTokenRole(secret, eventId, token);
        return verdict === 'ok' ? { role: role as MagicCaller['role'], via: 'token' } : null;
      })();
  if (!caller) return null;

  // ═══ BRIEF 57 — THE CREDENTIAL DIES WITH THE EVENT. ═══════════════════════════════════════
  //
  // Magic tokens are stateless HMACs, so before this there was nothing to delete and no way to
  // end one early: a closed event's dashboard link kept working until its own expiry, and its
  // view-session cookie kept working for as long as the row survived. A coordinator credential
  // exists for the duration of a live event and not one second longer.
  //
  // `dispatch` SURVIVES, deliberately. That token is not a coordinator session — it is minted by
  // a coordinator to hand evidence to authorities, who may open it hours after the alert ends.
  // Revoking it at closure would destroy an evidence handoff at the moment it matters, which the
  // rule's own "critical to evidence" clause excludes.
  if (caller.role !== 'dispatch') {
    const ev = await c.env.DB.prepare('SELECT credentialsRevokedAt FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ credentialsRevokedAt: number | null }>();
    if (ev?.credentialsRevokedAt != null) return null;
  }
  return caller;
}

async function requireMagicToken(c: AppContext): Promise<boolean> {
  const eventId = c.req.param('id') ?? '';
  void eventId;

  // ═══ Brief 33 Fix B §A/§E1 — COOKIE FIRST, TOKEN SECOND ═══════════════════════════════════
  //
  // Before this, every dashboard API call and the WebSocket URL carried `?t=<token>` — so the
  // credential was not merely in the address bar, it was in every request line and every proxy
  // log for the duration of a live alert. A view session moves all of that onto an HttpOnly
  // cookie the address bar and the logs never see.
  //
  // The token path REMAINS, and that is deliberate rather than transitional: §C requires links
  // already in the wild to keep working, and §B requires this to fail open. A coordinator whose
  // cookie was blocked, cleared, or never set still gets in with the tokened URL.
  // Accepts any valid role (guardian/coordinator/notified/dispatch) so the dashboard sub-routes
  // work on both the guardian and authority paths. Routes needing the ROLE call
  // `resolveMagicCaller` directly rather than re-verifying.
  return (await resolveMagicCaller(c)) !== null;
}

/**
 * Brief 33 Fix A §E3 — the dashboard HTML is never cached.
 *
 * The polling loop is INLINED into this page, so a browser holding a stale copy keeps running
 * the old unbounded loop after the fix ships — and no server-side change can reach it, because
 * that loop ignores response bodies. The page carried no Cache-Control at all.
 *
 * A service worker is NOT involved: the PWA registers its SW on the Pages origin and service
 * workers are origin-scoped, so it cannot intercept this Worker origin. No cache key to bump —
 * the gap was the missing header.
 */
const NO_STORE_HTML = { 'Cache-Control': 'no-store' } as const;

// The full dashboard HTML page (loud, contact-facing). Token verdict drives a
// friendly expired/invalid page instead of a bare 401 body.
app.get('/c/:id', async (c) => {
  const secret = c.env.MAGIC_LINK_SECRET;
  const eventId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  const presentedSession = getCookie(c, VIEW_COOKIE) ?? null;

  // ═══ Brief 33 Fix B §A — THE EXCHANGE ══════════════════════════════════════════════════════
  //
  // A tokened URL is swapped for a cookie and REDIRECTED to a bare one. An HTTP redirect leaves
  // only the destination in the back stack, so `…/c/<event>?t=<token>` never enters history,
  // autocomplete, or cross-device sync — and it costs no interstitial, no button, and no
  // JavaScript, which §0 requires above everything this brief fixes.
  //
  // Arriving WITHOUT a token is the ordinary case after the redirect: the cookie authenticates
  // and `verifyTokenRole` is skipped entirely.
  type LinkRole = 'guardian' | 'dispatch' | 'notified' | 'coordinator';
  let role = 'guardian' as LinkRole;
  if (!token) {
    const session = await getViewSession(c.env, presentedSession ?? '', eventId);
    if (!session) {
      // No token and no session: an expired cookie, a different browser, or a bare URL typed
      // from memory. Honest page, and §B's self-service path — never a dead end.
      return c.html(renderTokenPage('invalid'), 401);
    }
    role = session.role as typeof role;
  } else {
    const verified = secret
      ? await verifyTokenRole(secret, eventId, token)
      : ({ verdict: 'invalid' as const, role: 'guardian' as const });
    if (verified.verdict !== 'ok') {
      return c.html(renderTokenPage(verified.verdict === 'expired' ? 'expired' : 'invalid'), 401);
    }
    role = verified.role as typeof role;

    // §B — refuse ONLY the one case the brief names: a human already redeemed this link in a
    // DIFFERENT browser. Everything else proceeds, including a link nobody has redeemed and a
    // repeat visit from the browser that did.
    const disposition = await tokenDisposition(c.env, { eventId, token, presentedSessionKey: presentedSession });
    if (disposition.state === 'bound_elsewhere') {
      await audit(c.env, eventId, 'coordinator_link_spent', null, JSON.stringify({ redeemedAt: disposition.redeemedAt }));
      return c.html(renderTokenPage('spent'), 401);
    }

    // ═══ THE EXCHANGE IS SCOPED TO THE COORDINATOR PATH, AND HERE IS WHY ═══════════════════
    //
    // The AUTHORITY (dispatch) path binds its verified recipient to the TOKEN — `getBinding(env,
    // eventId, token)`, the Fix Brief 3 R3 identity gate. Redirecting that path to a bare URL
    // would sever the binding and drop a responding agency back to the registration form
    // mid-incident. That is a worse failure than the exposure being fixed.
    //
    // It is also a different exposure. This brief's threat model is explicit: the coordinator is
    // typically the survivor's CLOSEST CONTACT, plausibly on a shared device, plausibly in the
    // same household as the person the alert is about. A link in that browser's history
    // discloses an alert to whoever opens it next. The authority path is an agency workstation
    // whose holder has already registered and verified an identity against that token.
    //
    // Scoped, stated, and revisitable — not overlooked.
    const sessionKey = role === 'dispatch' ? null : await createViewSession(c.env, { eventId, token, role });
    if (sessionKey) {
      setCookie(c, VIEW_COOKIE, sessionKey, VIEW_COOKIE_OPTS);
      // 303: the browser follows with a GET and keeps only this destination in history.
      return c.redirect(`/c/${encodeURIComponent(eventId)}`, 303);
    }
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
      200,
      NO_STORE_HTML,
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
      200,
      NO_STORE_HTML,
    );
  }
  // Location-only view. Offer to take coordination only when unclaimed.
  await audit(c.env, eventId, claimed ? 'notified_view' : 'claimable_view', null, null);
  return c.html(renderNotifiedPage({ eventId, base: workerOrigin, state, claimable: !claimed }), 200, NO_STORE_HTML);
});

/**
 * Brief 33 Fix B §B — REDEEM. The human signal, and the ONLY thing that binds a link.
 *
 * Issued by the loaded dashboard page. Link scanners, SMS previewers and mail-security bots
 * issue GETs and do not execute page script, so they never reach here — which is precisely why
 * binding lives on a POST from the page rather than on the GET that serves it. A prefetch
 * therefore cannot spend a coordinator's link.
 *
 * ITS FAILURE MODE, STATED: a coordinator with JavaScript disabled never redeems either, so the
 * link stays unbound and keeps working from any browser. That is today's behaviour minus the
 * address bar, and it is the direction §B requires this to fail in — a coordinator wrongly
 * refused is worse than a token wrongly honoured.
 *
 * §E3 — THIS IS NOT A CLAIM. Brief 7 locked coordination to an explicit "Take coordination"
 * POST because merely opening a link must never claim it; duress would otherwise route to
 * whoever opened first. Redeeming binds a VIEW session and touches neither
 * `coordinatorClaimedAt` nor the `bbcoord` cookie.
 */
app.post('/v1/c/:id/redeem', async (c) => {
  const eventId = c.req.param('id');
  const sessionKey = getCookie(c, VIEW_COOKIE) ?? '';
  if (!sessionKey) {
    // No session to bind. Not an error — the tokened path still works.
    return c.json({ ok: true, redeemed: false, reason: 'no_session' }, 200);
  }
  const session = await getViewSession(c.env, sessionKey, eventId);
  if (!session) {
    return c.json({ ok: true, redeemed: false, reason: 'unknown_session' }, 200);
  }
  const done = await redeemViewSession(c.env, sessionKey, eventId);
  return c.json({ ok: true, redeemed: done }, 200);
});

/**
 * §B — the self-service path off a spent link. Never a dead end, never a support request.
 *
 * Re-sends through the SAME cascade channel the alert used. The fresh link is deliberately NOT
 * returned in the response: this endpoint is reachable without credentials by design (the caller
 * has, by definition, just been refused), and a page that mints a working credential for whoever
 * asks would be a larger hole than the one this brief closes. It goes to the contact the cascade
 * already knows, or nowhere.
 */
app.post('/v1/c/:id/fresh-link', async (c) => {
  const eventId = c.req.param('id');
  const event = await c.env.DB.prepare("SELECT id, status FROM events WHERE id = ?")
    .bind(eventId)
    .first<{ id: string; status: string }>();
  if (!event) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  await audit(c.env, eventId, 'coordinator_fresh_link_requested', null, null);
  // Re-notify through the existing cascade. Deliberately reuses the dispatcher rather than
  // minting and rendering a link here — one notification path, and it already knows who to
  // reach and how (§D: this brief does not change dispatch content).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await reissueLinkForEvent(c.env, eventId, new URL(c.req.url).origin);
      } catch {
        /* an honest failure surfaces as "could not send" on the page */
      }
    })(),
  );
  return c.json({ ok: true }, 202);
});

// Deliberate coordinator claim (Brief 7 / grooming). Atomic: the first POST that
// flips coordinatorClaimedAt from NULL wins and gets the bbcoord cookie; everyone
// else is told it is already claimed. This is the ONLY way coordination is taken
// — never by passively loading the dashboard.
app.post('/v1/c/:id/claim-coordinator', async (c) => {
  const eventId = c.req.param('id');

  // ═══ P0 FIX — THIS ROUTE HAD ITS OWN VERIFICATION AND IT DRIFTED ═══════════════════════════
  //
  // It read `c.req.query('t')` and called `verifyTokenRole` directly — the only route on
  // /v1/c/ path that did not go through the shared helper. When that helper learned to accept the
  // `bbview` cookie (Brief 33 Fix B), every route learned it except this one.
  //
  // The consequence was not subtle. Brief 33 Fix B also redirects the dashboard to a bare URL,
  // so the page's claim POST carries no token at all: every real claim 401'd, no coordinator
  // could take coordination, and because `isSupportEngaged()` is derived from the claim, every
  // event then closed on a single party with dual consent bypassed. Two P0 symptoms, one line.
  //
  // The private path is DELETED, not repaired. A route verifies through the shared helper or it
  // does not verify.
  const caller = await resolveMagicCaller(c);
  // Guardian-path callers only; the dispatch (authority) path never coordinates.
  if (!caller || caller.role === 'dispatch') {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const newKey = randomHex(16);
  // Brief 0B §3 race safety: only an ACTIVE, unclaimed event can be claimed. If a
  // solo survivor closed it a moment earlier, the claim matches zero rows and is
  // reported already-claimed/closed — no window where a solo close and a claim both
  // succeed on the same event.
  // Brief 56 §A2 — `cascadeStepAtClaim = cascadeStep` is captured in THIS statement, not read
  // before or after it. The claim and the halt are the same atomic write, so the step count
  // recorded here is exactly the one the halt acted on; a separate read could observe a different
  // value if a cascade step landed in between, and would then misreport how far word had spread.
  const claim = await c.env.DB.prepare(
    // A fresh claim is allowed when the event is unclaimed, OR when the coordinator path has
    // FAILED — the guardian tier needs to take over, and it can no longer do so by having the
    // escalation null the claim out from under the cascade halt (see closure-timeout.ts).
    "UPDATE events SET coordinatorClaimedAt = ?, coordinatorKey = ?, cascadeStepAtClaim = cascadeStep WHERE id = ? AND (coordinatorClaimedAt IS NULL OR coordinatorPathFailedAt IS NOT NULL) AND status = 'active'",
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
  const secureBody = ((await boundedJson<{ override?: boolean; overrideReason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { override?: boolean; overrideReason?: string }));
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
  const body = ((await boundedJson<{ fullName?: string; agency?: string; roleRef?: string; contactType?: string; contactValue?: string; scope?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as Record<string, string>));
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
  const body = ((await boundedJson<{ code?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { code?: string }));
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
    // ═══ BRIEF 33 FIX C — A REFUSAL THE DEPLOYED CLIENT CAN ACTUALLY HEAR. ═══════════════════
    //
    // This returned 401, and the shipped dashboard does `r.ok ? r.json() : null` and then
    // reschedules on null. So the ONE instruction that stops it — `terminal: true` — was
    // unreachable for exactly the callers who most needed to stop: tabs whose one-hour magic
    // token had expired. They polled every 3 seconds, indefinitely, invisibly.
    //
    // 200 with a terminal envelope is the only status the client in the field honours. It is
    // not an authorization decision — nothing about the event is disclosed, and the body is a
    // constant. It is a STOP INSTRUCTION delivered in the only dialect the caller speaks.
    //
    // The bounded client shipped alongside this stops on 401 directly, so this exists for the
    // pages already open on devices nobody can reach. It stays after they are gone: a status a
    // client ignores is not a refusal, whatever the number says.
    return c.json(
      {
        terminal: true,
        reason: 'session_expired',
        active: false,
        message: 'This session has expired. Reload to reconnect.',
      },
      200,
    );
  }
  const eventId = c.req.param('id');
  const state = await getContactState(c.env, eventId);
  if (!state) {
    return c.json({ error: 'not found' }, 404);
  }

  // Brief 33 Fix A §E1 — runaway-loop ceiling. Note carefully what this does NOT do: the
  // request has already invoked this Worker and already counted against the daily limit by
  // the time we get here, so this cannot protect the quota. What it does is stop a stuck tab
  // from doing real work, and hand any conforming client a terminal instruction to stop.
  // The limit is generous — a live coordinator polling at 3s uses half of it — because
  // throttling someone watching a live alert would be a worse failure than the one being
  // fixed. The first poll for a token always passes.
  // Brief 33 Fix C — KEYED ON THE CALLER THAT ACTUALLY EXISTS.
  //
  // This read `?t=`, and Brief 33 Fix B moved the coordinator's credential out of the query
  // string into the `bbview` cookie precisely so it would stop appearing in URLs. Every
  // cookie-borne tab therefore keyed on the EMPTY STRING and shared one bucket per event — so
  // one runaway tab throttled every other viewer of the same event, and a single viewer could
  // never be identified. A rate limit that cannot tell two callers apart is not a rate limit.
  const ceiling = checkPollCeiling(
    getCookie(c, VIEW_COOKIE) ?? c.req.query('t') ?? '',
    eventId,
    state.active,
  );
  if (!ceiling.allowed) {
    return c.json(
      {
        terminal: true,
        reason: 'poll_ceiling',
        active: state.active,
        closedAt: state.closedAt,
        closedDtg: state.closedDtg,
        message: 'This view is polling too fast and has been stopped. Reload for current state.',
      },
      // Brief 33 Fix C — 200, for the same reason as the expiry branch above. This was 429, and
      // 429 is not ok, and not-ok reschedules. The runaway-loop ceiling could therefore never
      // stop a runaway loop: the mitigation was delivered in a dialect the client does not read.
      200,
    );
  }

  // §E2 — a closed event answers with an explicit terminal flag, so a client stops for a
  // reason the SERVER named rather than inferring it. `active: false` already said this; the
  // flag says it in a way that survives future terminal reasons that are not closure.
  //
  // HONEST LIMIT: this cannot stop a page whose JavaScript predates the fix. That loop
  // ignores the response body entirely and re-arms on a timer no payload can reach. Only a
  // reload picks up the bounded client; until then the ceiling above is all that applies.
  return c.json(state.active ? state : { ...state, terminal: true, reason: 'event_closed' }, 200);
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

// Numeric chunk-by-sequence — registered AFTER the named /audio/ routes so
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
  const body = ((await boundedJson<{ timestamp?: number; sig?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { timestamp?: number; sig?: string }));
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
          await advanceEventCascade(c.env, ev, new URL(c.req.url).origin, 'heartbeat');
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
  const body = ((await boundedJson<{ status?: string; reasonSecured?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { status?: string; reasonSecured?: string }));
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
/**
 * Brief 36 §E — the capture's own encryption verdict, reported by the client at the end of
 * preparation. The server already records what it OBSERVED per chunk; this records what the
 * DEVICE concluded, so the report can state both which policy applied and which state was
 * actually reached rather than inferring one from the other later.
 *
 * Deliberately advisory: nothing downstream trusts this over the per-chunk observation. It
 * exists so a capture that never uploaded a chunk at all can still explain itself.
 */
/**
 * Brief 50 §C — the device reports whether it is transcribing at all.
 *
 * Zero transcript fragments is AMBIGUOUS: silence, not-transcribing, or not-yet. Only the device
 * knows which — Web Speech runs there and its failure is invisible to a server that simply
 * receives nothing. So the device says, and the coordinator surface stops presenting an empty
 * panel as though nobody spoke.
 *
 * Capture-path rules apply: this never gates anything, a malformed body is ignored rather than
 * refused, and a failure to record the state is not allowed to affect the capture it describes.
 */
app.post('/v1/events/:id/transcription-state', async (c) => {
  const eventId = c.req.param('id');
  const parsed = await boundedJson<{ state?: unknown; detail?: unknown }>(c.req, LIMITS.captureJsonBodyBytes);
  const state = ['active', 'degraded', 'unavailable'].includes(String(parsed.value?.state))
    ? String(parsed.value?.state)
    : null;
  if (!state) {
    // Never a refusal on the capture path — an unrecognised state is simply not recorded.
    return c.json({ ok: true, recorded: false, reason: 'unrecognised_state' }, 200);
  }
  const detail = clampString(parsed.value?.detail, 300).text || null;
  try {
    await c.env.DB.prepare('UPDATE events SET transcriptionState = ?, transcriptionDetail = ? WHERE id = ?')
      .bind(state, detail, eventId)
      .run();
  } catch {
    return c.json({ ok: true, recorded: false, reason: 'store_unavailable' }, 200);
  }
  return c.json({ ok: true, recorded: true }, 200);
});

app.post('/v1/events/:id/encryption-state', async (c) => {
  const eventId = c.req.param('id');
  const body = ((await boundedJson<{ state?: string; degradation?: string; reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { state?: string; degradation?: string; reason?: string }));
  const STATES = ['PREPARING', 'READY', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'];
  const DEGRADED = ['NONE', 'EVIDENCE_AT_RISK', 'EVIDENCE_NOT_RETAINED'];
  const state = STATES.includes(body.state ?? '') ? body.state! : null;
  const degradation = DEGRADED.includes(body.degradation ?? '') ? body.degradation! : null;
  if (!state) {
    return c.json({ error: 'invalid_state' }, 400);
  }
  // Freeze the POLICY that applied to this capture the first time it is reported, from the
  // owning account — not from the client, and not re-derived at read time, so a later policy
  // change cannot rewrite the history of a capture that already happened.
  await c.env.DB.prepare(
    `UPDATE events
        SET encryptionState = ?,
            degradationState = COALESCE(?, degradationState),
            encryptionPolicy = COALESCE(encryptionPolicy, (SELECT u.encryptionPolicy FROM users u WHERE u.id = events.userId))
      WHERE id = ?`,
  )
    .bind(state, degradation, eventId)
    .run();
  if (state === 'FAILED_TERMINAL') {
    await audit(c.env, eventId, 'encryption.capture_terminal', null, { reason: body.reason ?? null, degradation });
  }
  return c.json({ ok: true }, 200);
});

app.post('/v1/events/:id/reason-triggered', async (c) => {
  const eventId = c.req.param('id');
  const body = ((await boundedJson<{ reason?: string }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { reason?: string }));
  await c.env.DB.prepare('UPDATE events SET reasonTriggered = ? WHERE id = ?')
    .bind(body.reason ?? null, eventId)
    .run();
  return c.json({ ok: true }, 200);
});

/** The account that owns an event, for §B verification. One indexed read, and never a gate. */
async function eventOwnerUserId(env: Env, eventId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT userId FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null }>();
  return row?.userId ?? null;
}

app.post('/v1/events/:id/chunks/:sequence', async (c) => {
  const eventId = c.req.param('id');
  const sequence = Number(c.req.param('sequence'));
  const mimeType = c.req.header('X-Mime-Type') ?? 'application/octet-stream';
  // ═══ §A — THE ONE BOUND THAT IS ALLOWED TO REFUSE, AND WHY ═════════════════════════════════
  //
  // Every other capture-path bound clamps, because a truncated batch still carries most of the
  // evidence. A media chunk cannot be truncated: half a chunk is a corrupt chunk that will fail
  // its capture-time commitment and read as tampering in a report. There is no partial accept.
  //
  // So the bound is set where a real recording cannot reach it. Measured: chunks in real captures
  // run about 300 KB. The limit is 16 MB — roughly fifty times the observed size — which means it
  // can only be met by a client that is malfunctioning or hostile, and in both cases the isolate
  // is better off refusing than being exhausted by a body it cannot store anyway.
  //
  // It refuses LOUDLY: an explicit status and reason, never a silent drop, because a survivor's
  // device must be able to tell that this chunk did not land and try the next one.
  const declaredChunkBytes = Number(c.req.header('content-length') ?? Number.NaN);
  if (Number.isFinite(declaredChunkBytes) && declaredChunkBytes > LIMITS.chunkBytes) {
    return c.json(
      { ok: false, error: 'chunk_too_large', limitBytes: LIMITS.chunkBytes, declaredBytes: declaredChunkBytes },
      413,
    );
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > LIMITS.chunkBytes) {
    // The header lied or was absent. Measured after the fact, refused the same way.
    return c.json(
      { ok: false, error: 'chunk_too_large', limitBytes: LIMITS.chunkBytes, actualBytes: bytes.byteLength },
      413,
    );
  }
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'bin';
  const r2Key = `events/${eventId}/chunks/${sequence}.${ext}`;
  // Integrity (#C2): hash the chunk bytes on write and link into the event's
  // append-only hash chain before anything can touch the stored object. The bytes are
  // opaque either way — plaintext today, ciphertext when the client is armed — so this
  // is unchanged by the envelope (the chain hashes whatever bytes arrive).
  const sha256 = await hashBytes(bytes);

  /**
   * Brief 2 Fix A §B — THE DEVICE PROOF, checked here and NEVER able to stop a capture.
   *
   * This is an event-scoped write, so it is where `userHash` stops being sufficient. The verdict
   * is recorded on the chunk row and surfaced on the readiness panel; it does not branch the
   * upload. Only an ARMED account with a PRESENTED-and-WRONG signature is refused, and arming is
   * per account on evidence (§E1/§E3) — so today, dark, nothing is refused at all.
   *
   * The standing constraint is explicit: on the capture path a new comparison fails open by
   * default. A survivor mid-incident cannot fix a clock, re-register a device, or read an error.
   * A refused chunk is lost evidence, and lost evidence is the harm this system exists to prevent.
   */
  const deviceVerdict = await verifyDeviceProof(c.env, {
    userId: (await eventOwnerUserId(c.env, eventId)) ?? null,
    eventId,
    method: 'POST',
    path: new URL(c.req.url).pathname,
    bodyDigestHex: sha256,
    proof: {
      credentialId: c.req.header('X-Device-Id') ?? null,
      signature: c.req.header('X-Device-Signature') ?? null,
      timestamp: Number(c.req.header('X-Device-Timestamp') ?? NaN),
    },
  });
  if (deviceVerdict.decision === 'REFUSED') {
    // Reachable only for an account deliberately armed after its credential was proven working.
    return c.json({ error: 'device_signature_invalid', detail: deviceVerdict.detail }, 401);
  }

  const tz = await eventTzOffset(c.env, eventId);
  // Brief 26 — optional envelope metadata. PRESENCE-gated: a plaintext upload sends
  // neither header and behaves exactly as before. The server never REQUIRES these (even
  // with the flag armed) — capture availability is paramount and the client fails open.
  // Brief 38 §B — the header ROUTES, it does not decide. The server holds no key, so it
  // cannot verify a terminal marker cryptographically; that happens at decrypt, where a
  // stripped or forged marker no longer matches the AAD the chunk was sealed under. What the
  // server contributes is structural: it refuses a claim that could not possibly be last.
  const claimsFinal = c.req.header('X-Is-Final') === '1';
  const terminalReason = (c.req.header('X-Terminal-Reason') ?? '').slice(0, 40) || null;
  const commitment = (c.req.header('X-Plaintext-Commitment') ?? '').trim();

  // Brief 36 §B — OBSERVE the encryption state from the bytes, never from the client's
  // word. `declared` is kept only so a disagreement can be reported; it is not what gets
  // stored. This is what makes "dark observably dark": before this the schema had no way
  // to contradict a deployment that called itself encryption-armed while shipping clear
  // bytes, which is exactly what it had been doing since 2026-07-30.
  const observation = observeChunkEncryption(
    bytes,
    commitment,
    c.req.header('X-Encryption-State') ?? null,
    c.req.header('X-Encryption-Reason') ?? null,
  );
  const owner = await c.env.DB.prepare(
    'SELECT u.encryptionPolicy AS policy FROM events e LEFT JOIN users u ON u.id = e.userId WHERE e.id = ?',
  )
    .bind(eventId)
    .first<{ policy: string | null }>();
  const policy = owner?.policy ?? 'REQUIRED';

  if (observation.state === 'UNENCRYPTED_UNDECLARED') {
    // THE ORIGINAL DEFECT, now loud. Plaintext with no declaration means a client believes
    // it is encrypting and is not. Error level: nothing legitimate produces this once the
    // client-side state machine is deployed.
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'plaintext_chunk_undeclared',
        message: 'capture chunk arrived unencrypted with no declaration',
        eventId,
        sequence,
        policy,
      }),
    );
    await audit(c.env, eventId, 'encryption.undeclared_plaintext', null, { sequence, policy });
    c.executionCtx.waitUntil(
      operatorAlert(
        c.env,
        'plaintext_chunk_undeclared',
        `event ${eventId} sequence ${sequence}: capture chunk arrived unencrypted with NO declaration (policy ${policy})`,
      ),
    );
  } else if (observation.state === 'UNENCRYPTED_DECLARED') {
    // Legitimate (FAILED_TERMINAL) but never silent — it is recorded with its reason so
    // the report can state why this capture is not confidential.
    await audit(c.env, eventId, 'encryption.declared_plaintext', null, {
      sequence,
      reason: observation.reason,
      policy,
    });
  }
  if (observation.mismatch) {
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'encryption_declaration_mismatch',
        message: 'client declaration disagrees with the observed bytes',
        eventId,
        sequence,
        declared: observation.declared,
        observed: observation.state,
      }),
    );
  }

  // §B — the rejection path. Built, tested, and DARK: `encryptionEnforced` is off, so
  // today a non-conforming chunk is recorded and alerted rather than refused. Arming it is
  // Brief 47. Enforcing it now would reject every chunk from every existing account, none
  // of which can yet encrypt — the same shape of silent total failure this brief exists to
  // remove, just with a 4xx instead of a no-op.
  if (policy === 'REQUIRED' && encryptionEnforced(c.env) && !satisfiesRequiredPolicy(observation)) {
    await audit(c.env, eventId, 'encryption.chunk_rejected', null, {
      sequence,
      observed: observation.state,
      policy,
    });
    return c.json(
      {
        error: 'encryption_required',
        observed: observation.state,
        message: 'This account requires encrypted capture. The chunk was not stored.',
      },
      422,
    );
  }

  // §B/§C — reject an impossible terminal claim BEFORE storing it. A chunk that says it is
  // last while a higher sequence already exists is asserting completeness over a hole.
  let isFinal = 0;
  if (claimsFinal) {
    const problem = await terminalClaimProblem(c.env, eventId, sequence);
    if (problem) {
      await audit(c.env, eventId, 'capture.terminal_claim_rejected', null, { sequence, problem });
      console.log(
        JSON.stringify({ level: 'error', alert: 'terminal_claim_rejected', eventId, sequence, problem }),
      );
      return c.json({ error: 'terminal_claim_rejected', detail: problem }, 409);
    }
    isFinal = 1;
  }

  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await c.env.DB.prepare(
    // §C — orgId is attributed IN THE SAME STATEMENT via a subselect, not by a prior read.
    // This is the capture path: a separate `SELECT orgId FROM events` before every chunk write
    // would add a round trip and a failure mode to the one path that must never gain either.
    // NULL propagates for free — an unaffiliated survivor's event has orgId NULL and so does
    // her evidence, which is the correct and complete value.
    'INSERT OR REPLACE INTO chunks_index (eventId, sequence, r2Key, sizeBytes, mimeType, createdAt, sha256, tzOffsetMinutes, isFinal, encryptionState, terminalReason, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
  )
    .bind(eventId, sequence, r2Key, bytes.byteLength, mimeType, Date.now(), sha256, tz, isFinal, observation.state, terminalReason, eventId)
    .run();
  // §C — the natural idempotency key for a chunk is its own position. A retried upload
  // of the same sequence now returns the ORIGINAL chain result instead of appending a
  // second record for the same bytes, which the old path did on every network retry.
  await appendToChain(c.env, eventId, 'chunk', r2Key, sha256, `chunk:${sequence}`);
  // The signed PRE-ENCRYPTION plaintext commitment (change #1, admissibility): store it
  // and sign it into the SAME chain, so a later decryption is verifiable against a
  // capture-time commitment.
  if (commitment) {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO plaintext_commitments (eventId, sequence, plaintextHash, createdAt, orgId) VALUES (?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
    )
      .bind(eventId, sequence, commitment, Date.now(), eventId)
      .run();
    await appendToChain(c.env, eventId, 'commitment', `${eventId}/${sequence}`, commitment, `commitment:${sequence}`);
  }
  // §D — a terminal chunk closes the completeness question. Which flavour of COMPLETE
  // depends on the server's OWN observation of encryption, never the client's word: a
  // declared-plaintext chunk carries a truthful marker that cannot be authenticated.
  if (isFinal === 1) {
    await markTerminalReceived(c.env, eventId, sequence, observation.state === 'ENCRYPTED');
    await audit(c.env, eventId, 'capture.terminal_received', null, {
      sequence,
      authenticated: observation.state === 'ENCRYPTED',
      reason: terminalReason,
    });
  }
  return c.json({ ok: true, r2Key }, 201);
});

// Brief 26 — the per-capture wrapped data keys (states 3–4). One DEK per capture,
// wrapped to the survivor and (if enrolled) the org public key; uploaded once at capture
// start. Each wrappedDek is a sealed envelope (itself ciphertext under a public key), so
// the server stores it and can open none of it. hmac-authed like every event child route.
app.post('/v1/events/:id/wrapped-keys', async (c) => {
  const eventId = c.req.param('id');
  const body = ((await boundedJson<{ keys?: Array<{ recipientType?: string; recipientRef?: string; keyGeneration?: number; algId?: string; wrappedDek?: string }> }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { keys?: unknown }));
  // §A — clamped, not refused: these unwrap a survivor's own recordings.
  const { items: keys } = clampArray<{ recipientType?: string; recipientRef?: string; keyGeneration?: number; algId?: string; wrappedDek?: string }>(body.keys, LIMITS.batchItems);
  let stored = 0;
  for (const k of keys) {
    const recipientType = k.recipientType === 'org' ? 'org' : k.recipientType === 'survivor' ? 'survivor' : null;
    if (!recipientType || !k.algId || !k.wrappedDek) continue;
    await c.env.DB.prepare(
      'INSERT INTO wrapped_keys (id, eventId, sequence, recipientType, recipientRef, keyGeneration, algId, wrappedDek, createdAt, orgId) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
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
        eventId,
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
  // Capture fails OPEN: a malformed body must never 500 a capture endpoint. Guard the
  // parse and keep only well-formed points (numeric ts/lat/lon) so a partially-bad
  // payload stores what it can rather than throwing mid-batch. A body with no valid
  // points is a no-op 201, not an error.
  const body = ((await boundedJson<LocationPayload>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as Partial<LocationPayload>));
  const points = (Array.isArray(body.points) ? body.points : []).filter(
    (p) =>
      p != null &&
      typeof p.timestamp === 'number' &&
      typeof p.lat === 'number' &&
      typeof p.lon === 'number',
  );
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
  // §A — CLAMP, NEVER REJECT. This is the capture path: a refusal is lost evidence, not a retry.
  // Before this, a malformed body threw out of an unguarded `await c.req.json()` (a 500), and
  // `items.length` was read off whatever came back — so a body with no `items` at all was a
  // second throw. The array then fanned straight into D1.batch() unbounded.
  const parsed = await boundedJson<{ items?: ClassificationPayloadItem[] }>(c.req, LIMITS.captureJsonBodyBytes);
  const clamped = clampArray<ClassificationPayloadItem>(parsed.value?.items, LIMITS.batchItems);
  const dropped = clamped.dropped;
  // §B — validated PER ITEM, keeping what parses. `item.timestamp` went straight into a D1 bind
  // as whatever the body said it was; an object or a non-finite number there is a write failure
  // that takes the whole batch with it. Rejecting the batch would discard a survivor's other
  // records to punish one bad field, so the good ones are kept and the rejects are counted.
  //
  // The ORIGINAL items are filtered rather than replaced by their validated projection. An
  // earlier version rebuilt the row from the projection and recovered the array fields through a
  // Map keyed by timestamp — which silently cross-assigns when two records in a batch share a
  // timestamp, and a classifier emitting several per tick makes that ordinary rather than rare.
  const FIELDS = {
    timestamp: { check: check.finiteNumber(), required: true },
    threatLevel: { check: check.string(64) },
    summary: { check: check.string(LIMITS.stringChars) },
  } as const;
  const items = clamped.items.filter((i) => validate(i as unknown as Record<string, unknown>, FIELDS).value !== null);
  const rejected = clamped.items.length - items.length;
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
          clampString(item.summary, LIMITS.stringChars).text || null,
          JSON.stringify(item.languages ?? []),
        ),
      ),
    );
  }
  // The clamp is REPORTED, not swallowed. A client that sent 900 items and reads `count: 500`
  // with no other signal has been told a comfortable half-truth; `dropped` and `refusal` say
  // what actually happened to the rest.
  return c.json({ ok: true, count: items.length, dropped, rejected, refusal: parsed.refusal }, 201);
});

interface TranscriptPayload {
  fragments: Array<{ sequence: number; text: string; isFinal?: boolean }>;
}
app.post('/v1/events/:id/transcripts', async (c) => {
  const eventId = c.req.param('id');
  // §A — same disposition as classifications, and the same two latent throws removed.
  const parsed = await boundedJson<Partial<TranscriptPayload>>(c.req, LIMITS.captureJsonBodyBytes);
  const clampedFragments = clampArray<TranscriptPayload['fragments'][number]>(
    parsed.value?.fragments,
    LIMITS.batchItems,
  );
  const dropped = clampedFragments.dropped;
  // §B — `sequence` was bound to D1 as whatever arrived. A string or an object there fails the
  // write for the entire batch.
  const { items: fragments, rejected } = validateEach<{
    sequence: number;
    text: string;
    isFinal?: boolean;
  }>(clampedFragments.items, {
    sequence: { check: check.integerInRange(0, 1_000_000), required: true },
    text: { check: check.string(LIMITS.transcriptChars), required: true },
    isFinal: { check: check.boolean() },
  });
  if (fragments.length > 0) {
    await c.env.DB.batch(
      fragments.map((f) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO transcripts_index (eventId, sequence, text, isFinal, createdAt) VALUES (?, ?, ?, ?, ?)',
        ).bind(eventId, f.sequence, clampString(f.text, LIMITS.transcriptChars).text, f.isFinal ? 1 : 0, Date.now()),
      ),
    );
  }
  return c.json({ ok: true, count: fragments.length, dropped, rejected, refusal: parsed.refusal }, 201);
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
  const b = ((await boundedJson<OriginPayload>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as OriginPayload));
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
  const body = ((await boundedJson<{ pinHashWithSalt?: string; duress?: boolean }>(c.req, LIMITS.jsonBodyBytes)).value ?? ({} as { pinHashWithSalt?: string; duress?: boolean }));
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
export { IntegrityChain } from './integrity-do';
// Per-event WebSocket fan-out for live dashboard push (Brief 16 §4).
export { EventChannel } from './event-channel';

// fetch + scheduled (Cron Trigger). The scheduled handler runs the
// device-went-dark escalation and the vault integrity scan.
export default {
  fetch: app.fetch,
  scheduled,
};
