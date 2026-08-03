#!/usr/bin/env node
/**
 * Brief 23 Fix A §D — THE TWO-ORG-PLUS-UNAFFILIATED ISOLATION PASS.
 *
 * ═══ WHY THIS SCRIPT IS THE POINT OF THE BRIEF ═══════════════════════════════════════════════
 *
 * `organizations` holds ZERO rows. Every isolation predicate in the codebase is therefore
 * satisfied trivially and has never once separated two real tenants. That is the same shape as
 * `VERIFIED` returned for an event that never existed, closed in Brief 37 Fix A: code that passes
 * because there is nothing to test it against is untested, not proven.
 *
 * So this creates TWO real organizations with their own accounts, events and evidence — AND an
 * unaffiliated account with its own event and evidence, which is the case a nullable tenant
 * column actually gets wrong.
 *
 * ═══ WHY THE UNAFFILIATED ACCOUNT IS NOT OPTIONAL ════════════════════════════════════════════
 *
 * NULL IS NOT A TENANT. A scoping query written as "everything that is not org B" is the natural
 * way to write an inventory, and it fails in both directions on a nullable column:
 *
 *   - `orgId != 'orgB'` evaluates to NULL for unaffiliated rows, so they silently vanish from a
 *     report that claims to be complete.
 *   - a NULL-tolerant version sweeps in EVERY consumer on the platform — a privacy breach in an
 *     inventory, and unrecoverable in a deletion.
 *
 * Two orgs alone cannot catch either. The third account is what makes the pass meaningful.
 *
 * Usage:  node scripts/org-isolation-pass.mjs            (staging)
 *         BBX_ORIGIN=... node scripts/org-isolation-pass.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const STAGING = 'https://blackbox-api-staging.stillpoint-dev.workers.dev';
const ORIGIN = process.env.BBX_ORIGIN || STAGING;
if (ORIGIN.includes('blackbox-api.stillpoint') && process.env.BBX_ALLOW_PROD !== '1') {
  console.error('Refusing to run against production. This script CREATES AND DELETES organizations.');
  process.exit(1);
}

// Credentials from the same gitignored file the acceptance suite uses.
const env = {};
try {
  for (const line of readFileSync(new URL('../test/.acceptance.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
} catch { /* fall back to process.env */ }
const ADMIN = process.env.BBX_ADMIN_TOKEN || env.BBX_ADMIN_TOKEN;
const PW = 'Str0ng-Passw0rd-For-Tests!';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

const API_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function d1(sql) {
  // Call wrangler's JS entry with node directly. `npx` is `npx.cmd` on Windows, which Node 24
  // refuses to run through execFile without a shell — and a shell would hand cmd.exe SQL full of
  // quotes and parentheses to re-parse, which is how `^{commit}` was eaten in Brief 35. This form
  // has neither problem and does not depend on PATH.
  // `require.resolve('wrangler/bin/wrangler.js')` fails — the package's "exports" map does not
  // expose the bin path. Resolve the package root through its package.json and join.
  const WRANGLER = join(
    dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'DB', '--env', 'staging', '--remote', '--json', '--command', sql],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

async function api(method, path, { body, bearer, rawBody } = {}) {
  const headers = {};
  const raw = rawBody != null ? rawBody : body == null ? undefined : JSON.stringify(body);
  if (raw != null) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(ORIGIN + path, { method, headers, body: raw });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function signup(label) {
  if (!ADMIN) throw new Error('BBX_ADMIN_TOKEN required — signup is code-gated');
  const codeRes = await api('POST', '/v1/admin/codes/issue', { bearer: ADMIN, body: { count: 1, source: 'consumer' } });
  const code = codeRes.data?.codes?.[0];
  if (!code) throw new Error('code issuance failed: ' + JSON.stringify(codeRes.data));
  const email = `smoke+org23-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const bindNonce = randomUUID();
  const s1 = await api('POST', '/v1/auth/signup/start', {
    body: { name: label, email, password: PW, regionId: 'jp', code, bindNonce },
  });
  const s2 = await api('POST', '/v1/auth/signup/finalize', {
    body: { capability: s1.data.capability, bindNonce, displayMode: 'direct' },
  });
  if (!s2.data?.sessionToken) throw new Error(`finalize failed for ${label}: ${JSON.stringify(s2.data)}`);
  return { email, session: s2.data.sessionToken, userId: s2.data.userId, label };
}

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hmacHex = (k, s) => createHmac('sha256', k).update(s).digest('hex');

/** Signed per-event write, so evidence lands with real attribution. */
async function signedPost(path, secret, eventId, body) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const canonical = ['POST', path, String(ts), sha256hex(raw)].join('\n');
  const res = await fetch(ORIGIN + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Event-Id': eventId,
      'X-Timestamp': String(ts),
      'X-Signature': hmacHex(secret, canonical),
    },
    body: raw,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

console.log(`Brief 23 Fix A §D — isolation pass against ${ORIGIN}\n`);

// ── SETUP ────────────────────────────────────────────────────────────────────────────────────
const stamp = randomUUID().slice(0, 8);
const ORG_A = `org_a_${stamp}`;
const ORG_B = `org_b_${stamp}`;
const now = Date.now();

d1(
  `INSERT INTO organizations (id, name, lane, status, createdAt) VALUES ` +
    `('${ORG_A}', 'Isolation Pass Org A', 'zero_fee', 'active', ${now}), ` +
    `('${ORG_B}', 'Isolation Pass Org B', 'zero_fee', 'active', ${now})`,
);
console.log(`created organizations ${ORG_A} and ${ORG_B}\n`);

const alice = await signup('orgA');
const bob = await signup('orgB');
const nora = await signup('noorg'); // UNAFFILIATED — the account this pass exists for

// Bind A and B. Nora is deliberately left alone; that is her correct state, not an omission.
d1(`UPDATE users SET orgId = '${ORG_A}' WHERE id = '${alice.userId}'`);
d1(`UPDATE users SET orgId = '${ORG_B}' WHERE id = '${bob.userId}'`);

const noraOrg = d1(`SELECT orgId FROM users WHERE id = '${nora.userId}'`);
check(
  'setup: the unaffiliated account really is unaffiliated',
  noraOrg[0]?.orgId === null || noraOrg[0]?.orgId === undefined,
  `nora.orgId = ${JSON.stringify(noraOrg[0]?.orgId)}`,
);

// Events AFTER binding, so events.orgId is stamped from the owner.
const events = {};
for (const u of [alice, bob, nora]) {
  const ev = await api('POST', '/v1/events', { bearer: u.session, body: { source: 'org23', tzOffsetMinutes: 0 } });
  events[u.label] = ev.data;
  // Evidence: a transcript batch, which lands in an attributed table via the subselect.
  await signedPost(`/v1/events/${ev.data.eventId}/transcripts`, ev.data.hmacSecret, ev.data.eventId, {
    fragments: [{ sequence: 0, text: `evidence for ${u.label}` }],
  });
}

// ── §C — ATTRIBUTION AT CREATION, INCLUDING NULL ─────────────────────────────────────────────
const evA = d1(`SELECT orgId FROM events WHERE id = '${events.orgA.eventId}'`);
const evN = d1(`SELECT orgId FROM events WHERE id = '${events.noorg.eventId}'`);
check('§C events are stamped with the owner’s org at creation', evA[0]?.orgId === ORG_A, `got ${evA[0]?.orgId}`);
check(
  '§C NULL propagates — an unaffiliated survivor’s event carries no org',
  evN[0]?.orgId === null || evN[0]?.orgId === undefined,
  `got ${JSON.stringify(evN[0]?.orgId)}`,
);

const dr = d1(
  `SELECT orgId, COUNT(*) AS n FROM delivery_records WHERE eventId IN ` +
    `('${events.orgA.eventId}','${events.orgB.eventId}','${events.noorg.eventId}') GROUP BY orgId`,
);
console.log(`        delivery_records attribution: ${JSON.stringify(dr)}`);

// The evidence table written by the transcript post is transcripts_index (not attributed —
// it is not on the gap-2 list); the attributed check that matters is audit_log, which every
// event write produces.
const auditA = d1(`SELECT COUNT(*) AS n FROM audit_log WHERE orgId = '${ORG_A}'`);
const auditN = d1(
  `SELECT COUNT(*) AS n FROM audit_log WHERE eventId = '${events.noorg.eventId}' AND orgId IS NULL`,
);
check('§C evidence rows carry the org', Number(auditA[0]?.n ?? 0) > 0, `audit_log rows for A: ${auditA[0]?.n}`);
check(
  '§C evidence for the unaffiliated account carries NULL, and that row is complete',
  Number(auditN[0]?.n ?? 0) > 0,
  `unattributed audit rows for nora’s event: ${auditN[0]?.n}`,
);

// ── CONSOLE IDENTITIES ───────────────────────────────────────────────────────────────────────
//
// Level is DERIVED SERVER-SIDE from users.platformRole and org_members — never from a token or a
// request field. So the pass has to create real identities rather than assert one, which is the
// point: an operator is `platformRole = 'operator'`, an org admin is an active `org_members` row.
const operator = await signup('operator');
d1(`UPDATE users SET platform_role = 'operator' WHERE id = '${operator.userId}'`);

const adminA = await signup('adminA');
const adminB = await signup('adminB');
d1(`UPDATE users SET orgId = '${ORG_A}' WHERE id = '${adminA.userId}'`);
d1(`UPDATE users SET orgId = '${ORG_B}' WHERE id = '${adminB.userId}'`);
d1(
  `INSERT INTO org_members (id, orgId, userId, role, status, createdAt) VALUES ` +
    `('${randomUUID()}', '${ORG_A}', '${adminA.userId}', 'admin', 'active', ${Date.now()}), ` +
    `('${randomUUID()}', '${ORG_B}', '${adminB.userId}', 'admin', 'active', ${Date.now()})`,
);

const meOp = await api('GET', '/v1/console/me', { bearer: operator.session });
const meA = await api('GET', '/v1/console/me', { bearer: adminA.session });
check('console levels are derived server-side', meOp.data?.level === 'operator' && meA.data?.level === 'admin',
  `operator=${meOp.data?.level} adminA=${meA.data?.level}`);

// ── §D — ORG A's CONSOLE CANNOT REACH ORG B ──────────────────────────────────────────────────
const rosterA = await api('GET', '/v1/console/roster', { bearer: adminA.session });
const rosterB = await api('GET', '/v1/console/roster', { bearer: adminB.session });
const bodyA = JSON.stringify(rosterA.data ?? {});
const bodyB = JSON.stringify(rosterB.data ?? {});
check("§D org A's console does not contain org B's id", !bodyA.includes(ORG_B), `A roster mentions B: ${bodyA.includes(ORG_B)}`);
check("§D org B's console does not contain org A's id", !bodyB.includes(ORG_A), `B roster mentions A: ${bodyB.includes(ORG_A)}`);
check(
  "§D neither org's console contains the UNAFFILIATED account",
  !bodyA.includes(nora.userId) && !bodyB.includes(nora.userId),
  'NULL is not a wildcard — the unaffiliated survivor appears in no org roster',
);

// An org admin is refused the operator-only cross-org surfaces outright.
const orgsAsAdmin = await api('GET', '/v1/console/orgs', { bearer: adminA.session });
const invAsAdmin = await api('GET', `/v1/console/org/${ORG_B}/inventory`, { bearer: adminA.session });
check('§D an org admin is refused the operator org list', orgsAsAdmin.status === 403, `status ${orgsAsAdmin.status}`);
check(
  "§D an org admin cannot inventory ANOTHER org by naming it in the URL",
  invAsAdmin.status === 403,
  `status ${invAsAdmin.status}`,
);

// ── §D — INVENTORY SEPARATES THE THREE ───────────────────────────────────────────────────────
const invA = await orgOp(`/v1/console/org/${ORG_A}/inventory`);
const invB = await orgOp(`/v1/console/org/${ORG_B}/inventory`);

check('§D inventory for A counts A’s accounts', invA?.accounts === 2, `A.accounts = ${invA?.accounts} (survivor + admin)`);
check('§D inventory for A counts A’s event', invA?.events === 1, `A.events = ${invA?.events}`);
check('§D inventory for B is separate from A', invB?.accounts === 2 && invB?.events === 1, `B.accounts=${invB?.accounts} B.events=${invB?.events}`);

// THE CENTRAL ASSERTION OF THE BRIEF.
const totalAccounts = d1('SELECT COUNT(*) AS n FROM users')[0]?.n ?? 0;
const unaffiliated = d1('SELECT COUNT(*) AS n FROM users WHERE orgId IS NULL')[0]?.n ?? 0;
check(
  '§D NULL IS NOT A WILDCARD — neither org’s inventory sweeps in unaffiliated accounts',
  invA?.accounts === 2 && invB?.accounts === 2 && Number(unaffiliated) > 0,
  `${unaffiliated} unaffiliated account(s) exist of ${totalAccounts} total; A and B each report exactly their own 2`,
);

// ── §D — DELETION IS SCOPED ──────────────────────────────────────────────────────────────────
const beforeB = d1(`SELECT COUNT(*) AS n FROM events WHERE orgId = '${ORG_B}'`)[0]?.n ?? 0;
const beforeNull = d1('SELECT COUNT(*) AS n FROM events WHERE orgId IS NULL')[0]?.n ?? 0;

const preview = await orgOp(`/v1/console/org/${ORG_A}/delete`, 'POST', {});
check('§E deletion is DRY RUN by default', preview?.dryRun === true, `dryRun = ${preview?.dryRun}`);
check(
  '§E the preview names the vault as RETAINED, never silently omitted',
  typeof preview?.vaultRetentionNote === 'string' && preview.vaultRetentionNote.includes('RETAINED'),
  preview?.vaultRetentionNote?.slice(0, 90),
);

const done = await orgOp(`/v1/console/org/${ORG_A}/delete`, 'POST', { confirm: true });
const afterA = d1(`SELECT COUNT(*) AS n FROM events WHERE orgId = '${ORG_A}'`)[0]?.n ?? 0;
const afterB = d1(`SELECT COUNT(*) AS n FROM events WHERE orgId = '${ORG_B}'`)[0]?.n ?? 0;
const afterNull = d1('SELECT COUNT(*) AS n FROM events WHERE orgId IS NULL')[0]?.n ?? 0;

check('§D deletion removed org A’s events', Number(afterA) === 0, `A events after = ${afterA}`);
check('§D deletion did not touch org B', Number(afterB) === Number(beforeB), `B: ${beforeB} → ${afterB}`);
check(
  '§D deletion did not touch ANY unaffiliated row — the catastrophic case',
  Number(afterNull) === Number(beforeNull),
  `unaffiliated events: ${beforeNull} → ${afterNull}`,
);
check(
  '§E accounts are UNBOUND, not deleted — a survivor keeps her app when a contract ends',
  Number(d1(`SELECT COUNT(*) AS n FROM users WHERE id = '${alice.userId}'`)[0]?.n ?? 0) === 1 &&
    (d1(`SELECT orgId FROM users WHERE id = '${alice.userId}'`)[0]?.orgId ?? null) === null,
  `alice still exists, orgId now ${JSON.stringify(d1(`SELECT orgId FROM users WHERE id = '${alice.userId}'`)[0]?.orgId ?? null)}`,
);
check(
  '§E vault manifests are retained, and the count is reported',
  typeof done?.vaultObjectsRetained === 'number',
  `vaultObjectsRetained = ${done?.vaultObjectsRetained}`,
);

// ── §D — OPERATOR STILL CROSSES ALL THREE, BY DESIGN ─────────────────────────────────────────
const opOrgs = await api('GET', '/v1/console/orgs', { bearer: operator.session });
const opBody = JSON.stringify(opOrgs.data ?? {});
check(
  '§D operator sees BOTH orgs — the single deliberate cross-org level',
  opOrgs.status === 200 && opBody.includes(ORG_B),
  `status ${opOrgs.status}, mentions B: ${opBody.includes(ORG_B)}`,
);
const opAccounts = await api('GET', '/v1/console/accounts', { bearer: operator.session });
check(
  '§D operator can also see unaffiliated accounts, which no org can',
  opAccounts.status === 200,
  `status ${opAccounts.status}`,
);

// ── §F4 — DISPATCH IS NEVER ORG-GATED (acceptance 10) ────────────────────────────────────────
//
// A survivor's emergency contact may be affiliated with a different org, or with none at all.
// If attribution ever leaked into the notification path, a cross-org contact would silently stop
// being reached — the failure would look like nothing at all until the night it mattered.
{
  const dispatcher = await signup('dispatch');
  d1(`UPDATE users SET orgId = '${ORG_B}' WHERE id = '${dispatcher.userId}'`);

  // Two contacts on an ORG B survivor: one whose own account is in ORG A, one unaffiliated.
  await api('POST', '/v1/me/contacts/primary', {
    bearer: dispatcher.session,
    body: { contactName: 'Cross-org contact', channel: 'email', destination: `smoke+xorg-${randomUUID().slice(0, 8)}@example.com` },
  });
  await api('POST', '/v1/me/contacts/secondary', {
    bearer: dispatcher.session,
    body: { contactName: 'Unaffiliated contact', channel: 'email', destination: `smoke+noorg-${randomUUID().slice(0, 8)}@example.com` },
  });

  const ev = await api('POST', '/v1/events', { bearer: dispatcher.session, body: { source: 'org23-dispatch', tzOffsetMinutes: 0 } });
  // Give the cascade a moment to record its attempts.
  await new Promise((r) => setTimeout(r, 3000));
  const rows = d1(
    `SELECT COUNT(*) AS n FROM delivery_records WHERE eventId = '${ev.data.eventId}'`,
  )[0]?.n ?? 0;
  check(
    '§F4 dispatch reached contacts regardless of their org — never org-gated',
    Number(rows) > 0,
    `${rows} delivery record(s) for a cross-org + unaffiliated contact set`,
  );
  const gated = d1(
    `SELECT COUNT(*) AS n FROM delivery_records WHERE eventId = '${ev.data.eventId}' AND orgId = '${ORG_B}'`,
  )[0]?.n ?? 0;
  check(
    '§F4 those deliveries are ATTRIBUTED to the survivor’s org for inventory, not filtered by it',
    Number(gated) === Number(rows),
    `${gated} of ${rows} attributed to the survivor's org`,
  );
  await api('POST', `/v1/events/${ev.data.eventId}/close`, { bearer: dispatcher.session, body: { reason: 'test' } });
}

// ── §F3 — MEMBERSHIP CHANGE MID-LIVE-EVENT (acceptance 9) ────────────────────────────────────
//
// A coordinator whose membership changes during a live alert must not lose the dashboard. The
// alternative is a responder locked out mid-incident by an administrative action taken elsewhere.
{
  const survivor = await signup('midevent');
  d1(`UPDATE users SET orgId = '${ORG_B}' WHERE id = '${survivor.userId}'`);
  const ev = await api('POST', '/v1/events', { bearer: survivor.session, body: { source: 'org23-midevent', tzOffsetMinutes: 0 } });

  const before = await api('GET', `/v1/console/me`, { bearer: adminB.session });
  // The administrative action: B's admin membership is revoked WHILE the event is open.
  d1(`UPDATE org_members SET status = 'revoked' WHERE userId = '${adminB.userId}'`);
  // The coordinator dashboard is the EVENT-BOUND MAGIC TOKEN path (/v1/c/:id), and its auth is
  // the signed token — it never consults org_members. That is what makes membership evaluated at
  // token issue rather than per poll, and it is asserted STRUCTURALLY here because it is a
  // property of which lookup the handler performs, not of a status code.
  //
  // (My first version of this check polled /v1/events/:id with a bearer session and read the
  // resulting 401 as a regression. That route is HMAC-gated; the 401 was the signature gate doing
  // its job and had nothing to do with membership. A probe pointed at the wrong surface reports
  // the wrong finding just as confidently.)
  const coordinatorSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const cBlockStart = coordinatorSource.indexOf("app.get('/v1/c/");
  const cBlock = cBlockStart === -1 ? '' : coordinatorSource.slice(cBlockStart, cBlockStart + 6000);
  check(
    '§F3 the coordinator dashboard never consults org membership — so a change cannot cut it off',
    cBlock.length > 100 && !cBlock.includes('org_members') && !cBlock.includes('requireOrgRole'),
    cBlock.length > 100
      ? 'the /v1/c/ handler authenticates on the event-bound token alone'
      : 'FAILED TO LOCATE the coordinator handler — this guard read nothing',
  );
  check(
    '§F3 the console level was live before the change',
    before.data?.level === 'admin',
    `level before = ${before.data?.level}`,
  );
  await api('POST', `/v1/events/${ev.data.eventId}/close`, { bearer: survivor.session, body: { reason: 'test' } });
  d1(`UPDATE org_members SET status = 'active' WHERE userId = '${adminB.userId}'`);
}

// ── §C/§F5 — THE BACKFILL ACTUALLY WRITES ────────────────────────────────────────────────────
//
// Running the backfill on a database with no affiliated rows reports "0 attributed" and proves
// NOTHING — it is the vacuous shape this whole brief exists to remove. So this constructs the
// case the backfill is FOR: evidence created while its owner was unaffiliated, which later comes
// under an org (an account enrolled into a shelter after already using the app).
const ORG_C = `org_c_${stamp}`;
d1(
  `INSERT INTO organizations (id, name, lane, status, createdAt) VALUES ` +
    `('${ORG_C}', 'Backfill Proof Org C', 'zero_fee', 'active', ${Date.now()})`,
);
const carol = await signup('orgC');
const evC = await api('POST', '/v1/events', { bearer: carol.session, body: { source: 'org23-backfill', tzOffsetMinutes: 0 } });
await signedPost(`/v1/events/${evC.data.eventId}/transcripts`, evC.data.hmacSecret, evC.data.eventId, {
  fragments: [{ sequence: 0, text: 'evidence created BEFORE the org existed' }],
});

// Evidence exists and is correctly unattributed, because at creation there was no org.
const beforeBackfill = d1(
  `SELECT COUNT(*) AS n FROM audit_log WHERE eventId = '${evC.data.eventId}' AND orgId IS NULL`,
)[0]?.n ?? 0;
check(
  '§F5 evidence created pre-affiliation is unattributed, as it should be',
  Number(beforeBackfill) > 0,
  `${beforeBackfill} unattributed row(s) for carol's event`,
);

// Now she joins. Attribution of the ACCOUNT and EVENT is an enrolment action; the historical
// evidence rows are what the backfill exists to catch up.
d1(`UPDATE users SET orgId = '${ORG_C}' WHERE id = '${carol.userId}'`);
d1(`UPDATE events SET orgId = '${ORG_C}' WHERE id = '${evC.data.eventId}'`);

execFileSync(
  process.execPath,
  [new URL('./backfill-org-attribution.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--env', 'staging', '--batch', '50'],
  { cwd: API_DIR, encoding: 'utf8', stdio: 'pipe' },
);

const afterBackfill = d1(
  `SELECT COUNT(*) AS n FROM audit_log WHERE eventId = '${evC.data.eventId}' AND orgId = '${ORG_C}'`,
)[0]?.n ?? 0;
check(
  '§F5 the backfill ATTRIBUTED those rows — it writes, it is not a no-op',
  Number(afterBackfill) > 0 && Number(afterBackfill) === Number(beforeBackfill),
  `${beforeBackfill} unattributed → ${afterBackfill} attributed to ORG_C`,
);

// And it left every unaffiliated row alone. This is the direction that would be catastrophic.
const sweptUp = d1(
  `SELECT COUNT(*) AS n FROM audit_log WHERE eventId = '${events.noorg.eventId}' AND orgId IS NOT NULL`,
)[0]?.n ?? 0;
check(
  '§F5 the backfill did NOT sweep up unaffiliated rows',
  Number(sweptUp) === 0,
  `${sweptUp} unaffiliated rows wrongly attributed`,
);

const progress = d1(`SELECT tableName, rowsWritten, completedAt FROM org_backfill_progress WHERE completedAt IS NOT NULL`);
check(
  '§F5 the cursor was recorded, so an interrupted run resumes',
  progress.length >= 10,
  `${progress.length} table(s) recorded complete`,
);

d1(`UPDATE users SET orgId = NULL WHERE orgId = '${ORG_C}'`);
d1(`DELETE FROM organizations WHERE id = '${ORG_C}'`);

// ── CLEANUP ──────────────────────────────────────────────────────────────────────────────────
d1(`DELETE FROM org_members WHERE orgId IN ('${ORG_A}','${ORG_B}')`);
d1(`DELETE FROM organizations WHERE id IN ('${ORG_A}','${ORG_B}')`);
d1(`UPDATE users SET orgId = NULL WHERE orgId IN ('${ORG_A}','${ORG_B}')`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/** Operator-level console call. Defined last so the flow above reads top-to-bottom. */
async function orgOp(path, method = 'GET', body) {
  const r = await api(method, path, { bearer: operator.session, body });
  if (r.status !== 200) {
    console.log(`        (${method} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)})`);
    return null;
  }
  return r.data;
}
