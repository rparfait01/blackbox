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
 * Usage:  `pnpm deploy` — and ONLY that. Brief 35 Fix A §C removed the standalone entry
 *         point; invoking this directly runs a DIAGNOSTIC that cannot satisfy the gate.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deployTarget } from './api-origin.mjs';
import { consumeGateMarker } from './gate-nonce.mjs';
import { OUTCOME, countExternalRequest, gateRequestCount, proveCurrent } from './assert-currency.mjs';
import {
  ENVELOPE_ALG,
  decryptChunk,
  encryptChunk,
  exportPublicKey,
  generateDek,
  generateEnvelopeKeypair,
  importPublicKey,
  plaintextCommitment,
  randomIvPrefix,

  unwrapDek,
  wrapDek,
} from './canary-envelope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);
const ENVIRONMENT = args.environment || 'production';
const EXPECTED_BUILD = args.build && args.build !== 'true' ? args.build : null;

/**
 * Brief 35 Fix A §C — THE CANARY HAS NO STANDALONE ENTRY POINT.
 *
 * It used to be runnable as `node scripts/canary.mjs --environment=production --build=<sha>`,
 * and I used exactly that twice to finish a gate the currency poll had abandoned. Both deploys
 * were in fact correct, so it felt harmless. It is not: a gate an operator can complete by
 * hand is not a gate, and doing it twice is how it becomes the habit that replaces the
 * control. Same shape as `expectedPublicKey` being optional, and as
 * ENVELOPE_ENCRYPTION_ENABLED reading armed while encrypting nothing — a control that reports
 * as enforcing while not enforcing.
 *
 * So the canary now runs only when deploy.mjs hands it the nonce it minted for THIS run.
 * Anything else is a DIAGNOSTIC: it executes, it is useful, and it writes a marker saying it
 * cannot satisfy the gate — so a diagnostically-"passed" deploy is visibly identifiable as not
 * passed.
 */
const GATE_NONCE = process.env.BBX_GATE_NONCE ?? '';

/**
 * SINGLE USE, AND BOUND TO A RUN. A length check alone was not a gate.
 *
 * The first version of this accepted any string of 16+ characters, which meant the nonce could be
 * minted by hand (`BBX_GATE_NONCE=$(openssl rand -hex 24)`) or — much more likely — REPLAYED. That
 * second one is the actual failure mode, because it is not an attack, it is a convenience: the
 * deploy's gate stumbles, and the obvious next move is to re-run the canary with the same
 * environment still exported and call the deploy finished. That is exactly what I did, twice.
 *
 * So `deploy.mjs` writes a marker containing the nonce for the run, and the canary CONSUMES it —
 * reads it, checks it matches, checks it is fresh, and deletes it before doing anything else. A
 * second run with the same nonce finds no marker and is a diagnostic. Re-running the gate properly
 * means re-running `pnpm deploy`, which mints a new one.
 *
 * WHAT THIS DOES NOT CLAIM. An operator with a shell can write a marker file. Nothing local can
 * prevent that, and pretending otherwise would be the same species of lie as a control that
 * reports as enforcing while not enforcing. What it does is remove every path that can be taken
 * by habit or convenience, leaving only deliberate falsification — which is a different act, and
 * one a person notices themselves doing.
 */
const GATE = consumeGateMarker({ nonce: GATE_NONCE, markerPath: path.join(ROOT, '.gate-run') });
const IS_GATED = GATE.gated;
const IS_DIAGNOSTIC = !IS_GATED;

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
  countExternalRequest();
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
  countExternalRequest();
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

/** The server's own encryption tally, used to prove observation rather than assertion. */
async function readiness() {
  const r = await api('GET', '/v1/admin/encryption/readiness', { bearer: ADMIN });
  return r.data?.chunks ?? { encrypted: 0, plaintextDeclared: 0, plaintextUndeclared: 0 };
}

if (IS_DIAGNOSTIC) {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  DIAGNOSTIC RUN — THIS CANNOT SATISFY THE DEPLOY GATE (Brief 35 Fix A §C)  ║');
  console.log('║  Nothing it reports counts as a pass. Reason:                              ║');
  console.log(`║  ${GATE.reason.padEnd(74).slice(0, 74)}║`);
  console.log('║  To actually verify a deploy, run: pnpm deploy                             ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
}

console.log(`=== Brief 35 §C canary — ${ENVIRONMENT}${IS_DIAGNOSTIC ? ' (DIAGNOSTIC, NOT A GATE PASS)' : ''} ===`);
console.log(`    origin: ${ORIGIN}`);
if (!ADMIN) {
  fatal('no admin credential (BBX_ADMIN_TOKEN or workers/admin_token.txt). The gate cannot run.');
}

// ---- 1. the published build answers on this origin -------------------------------
//
// POLLED, not read once. A Worker deploy propagates across colos over some seconds, so a
// single read taken immediately after publish can legitimately still be served the
// previous version — and a gate that fails on that race is a gate that gets ignored,
// which is worse than no gate. `proveCurrent` is the SAME hardened poller the currency
// assertion uses: cache-busted, no-store, and fail-CLOSED (a stale or unreachable
// endpoint returns ok:false, never 'unknown' and never a skip).
step('worker reachable on the built-against origin');
const version = await api('GET', `/version?ts=${Date.now()}`);
if (version.status !== 200) {
  fatal(`GET /version returned ${version.status} — the PWA was built against an origin that does not answer.`);
}
ok(`/version answers → '${version.data?.version}'`);
if (EXPECTED_BUILD) {
  // Brief 35 Fix A §B — the poll now returns a CLASSIFICATION, not a boolean. Reading a
  // `.ok` that no longer exists made this `!undefined` → always fatal, which would have
  // failed the canary on every deploy including correct ones. Classify explicitly instead.
  const proven = await proveCurrent(`${ORIGIN}/version`, 'version', EXPECTED_BUILD);
  if (proven.outcome !== OUTCOME.CURRENT) {
    fatal(`worker is ${proven.outcome}: ${proven.detail} — client/server split.`);
  }
  ok(`build matches the commit being deployed (${EXPECTED_BUILD})`);
}

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
  fatal(
    `provisioning failed (${provision.status}): ${provision.data?.detail ?? JSON.stringify(provision.data)}`,
  );
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

// ---- 4b. THE REAL ENCRYPTION PATH (§F) --------------------------------------------
//
// The canary encrypts exactly as a phone does — its own keypair, a per-capture DEK
// wrapped to it, wrapped keys uploaded BEFORE anything is sealed, a proven encryptor,
// and only then a chunk. An exemption here would make this gate stop proving anything
// about the path that actually carries evidence.
//
// Every failure below names the ENCRYPTION STATE the client-side machine would be in, so
// a deploy that cannot encrypt says which step it died on rather than "upload failed".
step('encryption: the canary traverses the real path');
const encFatal = (state, why) =>
  fatal(`encryption state ${state} — ${why}. A deploy that cannot encrypt must not publish.`);

// PREPARING → the account must HAVE a key. A missing key is never terminal: mint one.
const canaryKeys = await generateEnvelopeKeypair();
const canaryPub = await exportPublicKey(canaryKeys.publicKey);
const pub = await api('POST', '/v1/me/pubkey', { bearer: canary.sessionToken, body: { pubkey: canaryPub } });
if (pub.status !== 200) {
  encFatal('FAILED_RETRYABLE', `publishing the canary public key returned ${pub.status}`);
}
ok('canary keypair generated and public key published');

const served = await api('GET', '/v1/me/keys', { bearer: canary.sessionToken });
if (served.status !== 200 || served.data?.pubkey !== canaryPub) {
  encFatal('FAILED_RETRYABLE', `the server did not serve back the published key (${served.status})`);
}
ok('server serves the canary public key back');

// Wrap the per-capture DEK and upload the wrapped copies BEFORE encrypting anything —
// a chunk encrypted under a DEK with no stored wrap is unrecoverable evidence.
const dek = await generateDek();
const ivPrefix = randomIvPrefix();
const wrapped = await wrapDek(dek, await importPublicKey(canaryPub));
const wrapRes = await signedRequest(
  'POST',
  `/v1/events/${eventId}/wrapped-keys`,
  hmacSecret,
  eventId,
  Buffer.from(
    JSON.stringify({
      keys: [
        {
          recipientType: 'survivor',
          recipientRef: null,
          keyGeneration: 0,
          algId: ENVELOPE_ALG,
          wrappedDek: JSON.stringify(wrapped),
        },
      ],
    }),
  ),
  { 'Content-Type': 'application/json' },
);
if (wrapRes.status !== 201 && wrapRes.status !== 200) {
  encFatal('FAILED_RETRYABLE', `wrapped-key upload returned ${wrapRes.status}`);
}
ok('per-capture DEK wrapped to the canary key and stored');

// READY requires PROOF, not a non-null object: seal a probe and open it again, and also
// open the wrapped DEK back to confirm the whole chain is recoverable.
try {
  const probe = new Uint8Array(Buffer.from('canary-self-test'));
  const sealedProbe = await encryptChunk({ dek, plaintext: probe, captureId: eventId, chunkIndex: 0xfffffffe, isFinal: false, ivPrefix });
  const back = await decryptChunk({ dek, framed: sealedProbe, captureId: eventId, chunkIndex: 0xfffffffe, isFinal: false });
  if (Buffer.compare(Buffer.from(back), Buffer.from(probe)) !== 0) throw new Error('round trip mismatch');
  await unwrapDek(wrapped, canaryKeys.privateKey); // the stored wrap really opens
} catch (error) {
  encFatal('FAILED_RETRYABLE', `encryptor self-test failed: ${error.message}`);
}
ok('encryptor PROVEN by round trip — state READY');

// SYNTHETIC bytes. Fixed, recognisable, and never microphone or camera data.
const synthetic = new Uint8Array(64).fill(0xbb);
const commitment = await plaintextCommitment(synthetic);
const sealed = await encryptChunk({ dek, plaintext: synthetic, captureId: eventId, chunkIndex: 0, isFinal: false, ivPrefix });
const before = await readiness();
const chunk = await signedRequest('POST', `/v1/events/${eventId}/chunks/0`, hmacSecret, eventId, Buffer.from(sealed), {
  'X-Mime-Type': 'application/octet-stream',
  'X-Plaintext-Commitment': commitment,
  'X-Is-Final': '0',
});
if (chunk.status !== 201 && chunk.status !== 200) {
  fail(`chunk upload returned ${chunk.status}: ${JSON.stringify(chunk.data)}`);
} else {
  ok('encrypted synthetic chunk accepted (the upload path is alive)');
}

// The claim that matters: the SERVER, from its own inspection of the bytes, recorded this
// chunk as ENCRYPTED. Not the client's word — the server's observation.
const after = await readiness();
if (after.encrypted === before.encrypted + 1 && after.plaintextUndeclared === before.plaintextUndeclared) {
  ok('server OBSERVED the chunk as ENCRYPTED (undeclared-plaintext count unchanged)');
} else {
  fail(
    `server did not record an encrypted chunk: encrypted ${before.encrypted}→${after.encrypted}, ` +
      `undeclared ${before.plaintextUndeclared}→${after.plaintextUndeclared}`,
  );
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
// §F — the canary is the expensive half of the gate. Report what it actually spent rather than
// the "~18" that used to be asserted in prose, so the deploy's total is a counted number.
console.log(`requests    : ${gateRequestCount()} issued by the gate so far (canary included)`);
console.log('──────────────────────────────────────');
if (failures) {
  console.error(`\n✗ CANARY FAILED — ${failures} check(s). The alert path is NOT proven on this deploy.`);
  process.exit(1);
}
if (IS_DIAGNOSTIC) {
  // §C — a DISTINGUISHABLE marker, and a non-zero exit so no script can mistake this for a
  // pass. The round trip really did work; what it did not do is satisfy the gate. Those are
  // different claims, and collapsing them is precisely what let a human finish the gate twice.
  console.log('\n◇ DIAGNOSTIC COMPLETE — the round trip worked, and THIS DID NOT SATISFY THE GATE.');
  console.log('  Deploy verification happens only inside `pnpm deploy`.');
  process.exit(2);
}
console.log('\n✓ canary round trip complete: the deployed client CAN reach this Worker, an event was');
console.log('  created and captured, nothing was dispatched to anyone, and the fixture is gone.');
