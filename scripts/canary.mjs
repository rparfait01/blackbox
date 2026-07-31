#!/usr/bin/env node
/**
 * Brief 35 §C — THE CANARY ROUND TRIP. The deploy gate that proves the alert path
 * actually exists on the origin just published.
 *
 * WHAT IT IS FOR, stated once. Matching build ids prove the PWA and the Worker came from
 * one commit. They do not prove the client can reach the server, and this product spent
 * its whole life one clean checkout away from publishing a build that could not: `.env`
 * is gitignored, the empty-origin fallback silently disabled event creation, heartbeat,
 * closure monitoring and every upload, and the deploy still went green. The only thing
 * that can disprove that state is a transaction that completes. So this opens a real
 * event through the ordinary authenticated trigger path, uploads a real chunk, beats a
 * real heartbeat, and reads the delivery log back.
 *
 * WHAT IT MUST NOT DO. Create a real emergency record, or contact a real person.
 *
 *   Identity   — a dedicated canary account, provisioned per environment, never a real one.
 *   Marking    — `isTest` is stamped SERVER-SIDE from that account's identity. This script
 *                cannot assert it, and there is no field it could assert it in.
 *   Dispatch   — suppressed at the notification router. Every delivery row reads
 *                `suppressed_test`; a `delivered` or `failed` row fails the gate, because
 *                either one means a message went at a provider.
 *   Payload    — synthetic fixed bytes. Never a microphone or a camera.
 *   Lifecycle  — TTL expiry in the Worker's cron, plus the explicit purge below.
 *   Isolation  — excluded from counters, exports, dashboards and vault sealing.
 *
 * IT PRINTS NO SECRETS. The admin token is read and used; it is never echoed, and the
 * status check reports only whether each required secret is PRESENT.
 *
 * Usage:  node scripts/canary.mjs [--environment=production] [--build=<sha>]
 *         BBX_ADMIN_TOKEN=… (or workers/admin_token.txt)
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deployTarget } from './api-origin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);
const ENVIRONMENT = args.environment || 'production';
const EXPECTED_BUILD = args.build && args.build !== 'true' ? args.build : null;

// §C first failure condition: "the origin is absent or invalid". Validated by the same
// rule the build gate uses, from the same tracked config, before a single request.
const TARGET = deployTarget(ENVIRONMENT);
const ORIGIN = TARGET.apiOrigin;

const ADMIN =
  process.env.BBX_ADMIN_TOKEN ||
  (() => {
    try {
      return readFileSync(path.join(ROOT, 'workers/admin_token.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  })();

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const step = (name) => console.log(`\n▸ ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failures += 1;
};
/** A failure that makes every later step meaningless — stop rather than cascade. */
function fatal(msg) {
  console.error(`\n✗ CANARY FAILED: ${msg}`);
  console.error('  The deploy is NOT proven. Do not treat this build as current.');
  process.exit(1);
}

async function api(method, urlPath, { body, bearer, raw, headers = {} } = {}) {
  const h = { ...headers };
  let payload = raw;
  if (body != null) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(ORIGIN + urlPath, { method, headers: h, body: payload });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/** HMAC-signed per-event request, byte-identical to the PWA's signRequest. */
async function signedRequest(method, urlPath, secret, eventId, bodyBytes, extraHeaders = {}) {
  const ts = Date.now();
  const canonical = [method.toUpperCase(), urlPath, String(ts), sha256hex(bodyBytes)].join('\n');
  const res = await fetch(ORIGIN + urlPath, {
    method,
    headers: {
      'X-Event-Id': eventId,
      'X-Timestamp': String(ts),
      'X-Signature': hmacHex(secret, canonical),
      ...extraHeaders,
    },
    body: bodyBytes.length ? bodyBytes : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

console.log(`=== Brief 35 §C canary — ${ENVIRONMENT} ===`);
console.log(`    origin: ${ORIGIN}`);
if (!ADMIN) {
  fatal('no admin credential (BBX_ADMIN_TOKEN or workers/admin_token.txt). The gate cannot run.');
}

// ---- 1. the published build answers on this origin -------------------------------
step('worker reachable on the built-against origin');
const version = await api('GET', `/version?ts=${Date.now()}`);
if (version.status !== 200) {
  fatal(`GET /version returned ${version.status} — the PWA was built against an origin that does not answer.`);
}
ok(`/version → '${version.data?.version}'`);
if (EXPECTED_BUILD && version.data?.version !== EXPECTED_BUILD) {
  fatal(`worker reports '${version.data?.version}', expected '${EXPECTED_BUILD}' — client/server split.`);
}
if (EXPECTED_BUILD) ok(`build matches the commit being deployed (${EXPECTED_BUILD})`);

// ---- 2. required secrets and bindings are PRESENT (never their values) ------------
step('required bindings and secrets are present (shape only, no values)');
const status = await api('GET', '/v1/admin/canary/status', { bearer: ADMIN });
if (status.status !== 200) {
  fatal(`canary status returned ${status.status} — admin credential rejected, or this build predates Brief 35.`);
}
const { bindings, secrets } = status.data.environment;
for (const b of ['DB', 'MEDIA', 'VAULT']) {
  if (bindings[b]) ok(`binding ${b}: present`);
  else fail(`binding ${b}: MISSING`);
}
if (secrets.SESSION_SECRET || secrets.MAGIC_LINK_SECRET) ok('session signing secret: present');
else fail('session signing secret: MISSING (no account can authenticate)');
if (secrets.INTEGRITY_SIGNING_KEY) ok('INTEGRITY_SIGNING_KEY: present');
else fail('INTEGRITY_SIGNING_KEY: MISSING (custody manifests cannot be signed)');
// At least one channel must be able to deliver, or no contact could be reached at all.
const channels = ['SENDGRID_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'TWILIO_AUTH_TOKEN'].filter((k) => secrets[k]);
if (channels.length) ok(`deliverable channel credentials: ${channels.join(', ')}`);
else fail('NO channel credential is set — every alert would reach nobody');
if (failures) fatal(`${failures} required binding/secret check(s) failed.`);

// ---- 3. provision the canary identity --------------------------------------------
step('provision the canary account (reserved addresses, server-set flag)');
// Clean slate first: a previous run that died leaves rows the isolation assertions
// below would otherwise trip over.
await api('POST', '/v1/admin/canary/purge', { bearer: ADMIN });
const provision = await api('POST', '/v1/admin/canary/provision', { bearer: ADMIN });
if (provision.status !== 200 || !provision.data?.sessionToken) {
  fatal(`provisioning failed (${provision.status}): ${JSON.stringify(provision.data)}`);
}
const canary = provision.data;
ok(`canary account ${canary.email} (userId ${canary.userId.slice(0, 8)}…)`);

// ---- 4. THE ROUND TRIP -----------------------------------------------------------
step('full round trip: open event → upload chunk → heartbeat');
const opened = await api('POST', '/v1/events', {
  bearer: canary.sessionToken,
  body: { source: 'deploy-canary', tzOffsetMinutes: 0 },
});
if (opened.status !== 201 || !opened.data?.eventId) {
  fatal(
    `POST /v1/events returned ${opened.status} — THE ALERT PATH DOES NOT WORK on this deploy: ` +
      JSON.stringify(opened.data),
  );
}
const { eventId, hmacSecret } = opened.data;
ok(`event created server-side (${eventId.slice(0, 8)}…)`);

// SYNTHETIC bytes. Fixed, recognisable, and never microphone or camera data.
const synthetic = Buffer.alloc(64, 0xbb);
const chunk = await signedRequest('POST', `/v1/events/${eventId}/chunks/0`, hmacSecret, eventId, synthetic, {
  'X-Mime-Type': 'application/octet-stream',
});
if (chunk.status !== 201 && chunk.status !== 200) {
  fail(`chunk upload returned ${chunk.status}: ${JSON.stringify(chunk.data)}`);
} else {
  ok('synthetic capture chunk accepted (the upload path is alive)');
}

const beat = await signedRequest('POST', `/v1/events/${eventId}/heartbeat`, hmacSecret, eventId, Buffer.alloc(0));
if (beat.status !== 200 && beat.status !== 204) fail(`heartbeat returned ${beat.status}`);
else ok('heartbeat accepted');

// ---- 5. dispatch was SUPPRESSED, and provably so ---------------------------------
step('dispatch suppressed server-side — nothing reached a provider');
let suppressed = 0;
let delivered = 0;
let failedRows = 0;
for (let i = 0; i < 12; i += 1) {
  const q = async (s) =>
    (await api('GET', `/v1/admin/events/${eventId}/deliveries?status=${s}`, { bearer: ADMIN })).data?.count ?? 0;
  [suppressed, delivered, failedRows] = await Promise.all([q('suppressed_test'), q('delivered'), q('failed')]);
  if (suppressed > 0) break;
  await sleep(2000);
}
if (suppressed > 0) ok(`${suppressed} delivery row(s) recorded as 'suppressed_test'`);
else fail("no 'suppressed_test' delivery row appeared — the cascade never ran, or suppression did not engage");
// §C: "a test event reaches a live dispatch path" fails the deploy. This is that check.
if (delivered === 0 && failedRows === 0) ok('zero delivered/failed rows — no provider was called');
else fail(`A TEST EVENT REACHED A LIVE DISPATCH PATH: delivered=${delivered}, failed=${failedRows}`);

// ---- 6. isolation ----------------------------------------------------------------
step('isolation: the canary event is not offerable as evidence');
const reports = await api('GET', '/v1/me/reports/events', { bearer: canary.sessionToken });
if (reports.status === 200) {
  const listed = (reports.data?.events ?? []).some((e) => e.eventId === eventId);
  if (listed) fail('the canary event appears in the owner report list — it is being treated as evidence');
  else ok('excluded from the report/export list');
} else if (reports.status === 404) {
  ok('report surface is dark on this environment — nothing to exclude from');
} else {
  fail(`report list returned ${reports.status}`);
}

// ---- 7. purge, and CONFIRM ---------------------------------------------------------
step('purge');
const purge = await api('POST', '/v1/admin/canary/purge', { bearer: ADMIN });
if (purge.status !== 200 || purge.data?.remaining !== 0) {
  fail(`purge did not confirm: status ${purge.status}, remaining ${purge.data?.remaining}`);
} else {
  ok(`purged ${purge.data.events} event(s), ${purge.data.r2Deleted} object(s) — 0 remaining`);
}

console.log('\n─────────────── canary ───────────────');
console.log(`environment : ${ENVIRONMENT}`);
console.log(`origin      : ${ORIGIN}`);
console.log(`worker build: ${version.data?.version}`);
console.log('──────────────────────────────────────');
if (failures) {
  console.error(`\n✗ CANARY FAILED — ${failures} check(s). The alert path is NOT proven on this deploy.`);
  process.exit(1);
}
console.log('\n✓ canary round trip complete: the deployed client CAN reach this Worker, an event was');
console.log('  created and captured, nothing was dispatched to anyone, and the fixture is gone.');
