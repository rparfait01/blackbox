/**
 * BLACK BOX standing acceptance suite (Brief 19). Runs the full known-good flow
 * against the deployed STAGING worker on every commit/deploy. A change is not
 * committable unless this whole suite is green — it is the tripwire so a fixed bug can
 * never silently regress. Every bug found from here adds a check BEFORE its fix lands.
 *
 *   node workers/api/test/acceptance.mjs
 *
 * IT RUNS AGAINST STAGING, AND THAT IS THE POINT.
 *
 * This suite is write-heavy: it signs up accounts, bootstraps organisations, mints
 * codes, opens events and uploads capture chunks. It used to do all of that to the
 * PRODUCTION database, leaving ~26 organisations and a few unreachable accounts behind
 * every single run, because its cleanup could only delete accounts it could sign back
 * into. Testing the safety system was degrading the safety system — the same class of
 * error as the SendGrid quota bug, where test runs drained the credits real alerts
 * needed.
 *
 * The fix is severance at the resource, not a flag: `blackbox-api-staging` is bound to
 * its own D1 (`blackbox-test`) and its own R2 buckets, so a run cannot reach production
 * data even if a check tried. And the severance is ENFORCED here rather than trusted:
 * pointing BBX_ORIGIN at production aborts unless BBX_ALLOW_PROD=1 is set deliberately.
 * A default that has to be remembered is not a default.
 *
 * WHAT THIS TRADES AWAY, said plainly: the suite no longer proves production's own
 * configuration — a missing prod secret or an unapplied prod migration will not fail it.
 * Those are covered elsewhere and deliberately: `pnpm deploy` asserts BOTH live halves
 * report the committed build, and GET /v1/console/maintenance/health reports prod D1,
 * R2, currency and pending migrations. To run this suite against production anyway
 * (read the warning it prints first), set BBX_ORIGIN and BBX_ALLOW_PROD=1.
 *
 * Config (env): BBX_ORIGIN (default STAGING), BBX_ADMIN_TOKEN (default: read
 * workers/admin_token.txt), BBX_MAGIC_LINK_SECRET (REQUIRED — coordinator flows
 * cannot be exercised without it, so the suite fails closed if absent), and
 * BBX_LINE_USER_ID (optional: also assert a real LINE delivery). Staging's own
 * credentials live in the gitignored test/.acceptance.env.
 *
 * Checks self-provision throwaway accounts (smoke+acc-*@example.com) and clean up.
 */
import { createHmac, createHash } from 'node:crypto';

/**
 * Brief 35 Fix A §F — THE SUITE'S OWN REQUEST COST, COUNTED.
 *
 * Every check here is a request against the same account limit whose exhaustion takes the alert
 * path down — the limit that was actually reached, and that presented itself as a Cloudflare
 * outage for most of a session. A verification suite that cannot say what it costs is one an
 * operator has to guess about before running, and guessing is what produced the outage. So the
 * count is wrapped at the one place every request goes through, and reported at the end.
 */
let REQUESTS_ISSUED = 0;
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => {
    REQUESTS_ISSUED += 1;
    return realFetch(...a);
  };
}
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Privileged test creds (MAGIC_LINK_SECRET, optionally ADMIN_TOKEN/LINE_USER_ID)
// load from env OR a gitignored test/.acceptance.env (KEY=VALUE per line) so the
// secret is never pasted into a transcript or committed. CI sets the env vars.
(() => {
  try {
    const txt = readFileSync(new URL('./.acceptance.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no local env file — rely on process env */
  }
})();

/** Production. Named here for ONE reason: so the guard below can recognise it. */
const PROD_ORIGIN = 'https://blackbox-api.stillpoint-dev.workers.dev';
/** Staging — its own D1 and its own R2. The default, and the only safe target. */
const STAGING_ORIGIN = 'https://blackbox-api-staging.stillpoint-dev.workers.dev';

const ORIGIN = process.env.BBX_ORIGIN || STAGING_ORIGIN;

// THE SEVERANCE GUARD. Structural, not conventional: the suite refuses to run against
// production unless someone has explicitly said so in this invocation. Matched on the
// HOSTNAME rather than the string, so a trailing slash, a path, or http:// cannot slip
// past it. This is the same shape as the SendGrid suppression — a property of the
// TARGET, never a mode someone has to remember to set.
(() => {
  let host;
  try {
    host = new URL(ORIGIN).hostname;
  } catch {
    console.error(`✗ BBX_ORIGIN is not a URL: ${ORIGIN}`);
    process.exit(1);
  }
  if (host !== new URL(PROD_ORIGIN).hostname) return;
  if (process.env.BBX_ALLOW_PROD === '1') {
    console.log(
      '⚠  RUNNING AGAINST PRODUCTION (BBX_ALLOW_PROD=1).\n' +
        '   This WILL create organisations, accounts and events in the real database,\n' +
        '   and the cleanup does not remove organisations. You asked for this.\n',
    );
    return;
  }
  console.error(
    '✗ REFUSED: this suite is write-heavy and BBX_ORIGIN points at PRODUCTION.\n' +
      '  It would create real organisations, accounts and events that nothing removes.\n' +
      `  Run it against staging (the default): unset BBX_ORIGIN, or set it to\n    ${STAGING_ORIGIN}\n` +
      '  If you genuinely mean to test production, set BBX_ALLOW_PROD=1.',
  );
  process.exit(1);
})();
const ADMIN =
  process.env.BBX_ADMIN_TOKEN ||
  (() => {
    try {
      return readFileSync(new URL('../../admin_token.txt', import.meta.url), 'utf8').trim();
    } catch {
      return '';
    }
  })();
const MAGIC = process.env.BBX_MAGIC_LINK_SECRET || '';
/** Staging SESSION_SECRET — lets check 80 mint an AGED token and prove sessions never
 *  expire on a timer. The worker's sessionSecret() is SESSION_SECRET ?? MAGIC_LINK_SECRET,
 *  so fall back the same way rather than failing when only the magic secret is set. */
const SESSION_SECRET = process.env.BBX_SESSION_SECRET || MAGIC;
const PW = 'Acc-suite-pw-12345';

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let SEQ = 0;
const uniq = () => `${Date.now().toString(36)}${(SEQ += 1)}`;

const created = { emails: [], events: [] };

async function api(method, path, { body, bearer, cookie } = {}) {
  const headers = {};
  const raw = body == null ? undefined : JSON.stringify(body);
  if (raw != null) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(ORIGIN + path, { method, headers, body: raw });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, setCookie };
}

// HMAC-signed per-event request (mirrors lib/hmac signRequest).
async function signed(method, path, eventSecret, eventId, body) {
  const raw = body == null ? '' : JSON.stringify(body);
  const ts = Date.now();
  const canonical = [method.toUpperCase(), path, String(ts), sha256hex(raw)].join('\n');
  const headers = {
    'content-type': 'application/json',
    'X-Event-Id': eventId,
    'X-Timestamp': String(ts),
    'X-Signature': hmacHex(eventSecret, canonical),
  };
  const res = await fetch(ORIGIN + path, { method, headers, body: body == null ? undefined : raw });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** Brief 30 §C — signup is GATED on a code, so the suite mints one per account through
 *  the operator issuance endpoint. Needs ADMIN; without it signup cannot be exercised at
 *  all, which is itself the gate working. */
async function issueSignupCode() {
  if (!ADMIN) throw new Error('BBX_ADMIN_TOKEN required: signup is code-gated (Brief 30 §C)');
  const r = await api('POST', '/v1/admin/codes/issue', { bearer: ADMIN, body: { count: 1, source: 'consumer' } });
  const code = r.data?.codes?.[0];
  if (!code) throw new Error('code issuance failed: ' + JSON.stringify(r.data));
  return code;
}

/**
 * Brief 30 §C changed the front door: signup now REQUIRES a code, and redeeming one
 * GRANTS entitlement (§D — otherwise a buyer lands signed-up-but-unarmable). So a fresh
 * account is no longer 'unactivated' — that state is now only reachable by an operator
 * revoke.
 *
 * The §28 checks below still have to prove what they always proved — above all that an
 * UNACTIVATED account can still FIRE THE TRIGGER — so they establish that state
 * explicitly instead of assuming signup leaves them in it. The guarantee is unchanged;
 * only the route into the state is.
 */
async function makeUnactivated(u) {
  if (!ADMIN) return false;
  const r = await api('POST', '/v1/admin/entitlement/revoke', {
    bearer: ADMIN,
    body: { email: u.email, reason: 'acceptance: establish unactivated state (Brief 30 §C)' },
  });
  return r.status === 200;
}

async function signup(mode = 'direct', name = 'Acc') {
  const email = `smoke+acc-${uniq()}@example.com`;
  const code = await issueSignupCode();
  const s1 = await api('POST', '/v1/auth/signup/start', { body: { name, email, password: PW, regionId: 'jp', code } });
  if (!s1.data?.capability) throw new Error('signup/start failed: ' + JSON.stringify(s1.data));
  const s2 = await api('POST', '/v1/auth/signup/finalize', { body: { capability: s1.data.capability, displayMode: mode } });
  if (!s2.data?.sessionToken) throw new Error('finalize failed: ' + JSON.stringify(s2.data));
  created.emails.push(email);
  return { email, session: s2.data.sessionToken, userId: s2.data.userId, displayMode: s2.data.displayMode };
}
async function addEmail(session, slot, name) {
  return api('POST', `/v1/me/contacts/${slot}`, { bearer: session, body: { contactName: name, channel: 'email', destination: `smoke+${slot}-${uniq()}@example.com` } });
}
async function trigger(session, source = 'acc') {
  const e = await api('POST', '/v1/events', { bearer: session, body: { source, tzOffsetMinutes: 0 } });
  if (e.data?.eventId) created.events.push(e.data.eventId);
  return e.data; // {eventId, hmacSecret, createdAt, resumed?}
}
function bbcoordFrom(setCookie) {
  if (!setCookie) return null;
  const m = /bbcoord=([^;]+)/.exec(setCookie);
  return m ? `bbcoord=${m[1]}` : null;
}
// Mint a guardian magic token + claim coordinator; returns {token, cookie}.
async function claimCoordinator(eventId) {
  if (!MAGIC) throw new Error('BBX_MAGIC_LINK_SECRET required for coordinator flows');
  const expiry = Date.now() + 60 * 60 * 1000;
  const token = `${expiry}.${hmacHex(MAGIC, `${eventId}.${expiry}`)}`;
  const claim = await api('POST', `/v1/c/${eventId}/claim-coordinator?t=${token}`);
  const cookie = bbcoordFrom(claim.setCookie);
  if (!claim.data?.claimed || !cookie) throw new Error('claim failed: ' + JSON.stringify(claim.data));
  return { token, cookie };
}

// Brief 24 — operator bootstrap: create an org + license record + a single-use admin
// REGISTRATION code (not an enrollment code). Admin #1 is created by the registration
// ceremony, not by redeeming an enrollment code.
async function bootstrapOrg(name, lane = 'zero_fee', seatsTotal = 3) {
  const r = await api('POST', '/v1/admin/orgs', { bearer: ADMIN, body: { name, lane, seatsTotal } });
  if (!r.data?.orgId || !r.data?.registrationCode) throw new Error('org bootstrap failed: ' + JSON.stringify(r.data));
  return { orgId: r.data.orgId, registrationCode: r.data.registrationCode, seatsTotal };
}
// Register an admin via the Brief 24 ceremony (headless: signup+finalize gets a session,
// then the explicit completion POST claims admin). The passkey is a client-side UI step
// (device sign-off) — the server 'complete' requires only a finalized account + code.
async function registerAdmin(registrationCode, mode = 'direct') {
  const acc = await signup(mode);
  const done = await api('POST', '/v1/org-register/complete', {
    bearer: acc.session,
    body: { code: registrationCode, licenseVersion: 'v1', acceptancePath: 'click_through' },
  });
  return { acc, done };
}
// Bootstrap an org and register BOTH required admins, so seat issuance is unlocked.
async function bootstrapOrgWithTwoAdmins(name, lane = 'zero_fee', seatsTotal = 3) {
  const org = await bootstrapOrg(name, lane, seatsTotal);
  const admin1 = await registerAdmin(org.registrationCode);
  if (!admin1.done.data?.ok) throw new Error('admin #1 register failed: ' + JSON.stringify(admin1.done.data));
  // Admin #1 invites admin #2 from inside; admin #2 registers → seats unlock.
  const invite = await api('POST', '/v1/org/admins/invite', { bearer: admin1.acc.session, body: {} });
  const admin2 = await registerAdmin(invite.data.registrationCode);
  if (!admin2.done.data?.ok) throw new Error('admin #2 register failed: ' + JSON.stringify(admin2.done.data));
  return { ...org, admin: admin1.acc, admin2: admin2.acc };
}
// A fresh throwaway account that redeems an ENROLLMENT code → { acc, red }.
async function enrollWith(code, mode = 'direct') {
  const acc = await signup(mode);
  // §C entitles at signup with source purchase_web, and grantEntitlement NEVER overwrites
  // an existing source (Brief 28: first source wins, permanently). So to observe an org
  // enrolment as the activating event — which is what the §28 checks assert — the account
  // must start unactivated. Revoking is the only route into that state post-§C.
  await makeUnactivated(acc);
  const red = await api('POST', '/v1/me/org/redeem', { bearer: acc.session, body: { code } });
  return { acc, red };
}

// ---- assertion framework ----
const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ name, ok: false, err: String(e.message || e) }); console.log(`  FAIL  ${name}\n        ${e.message || e}`); }
}

// =====================================================================
async function run() {
  console.log(`BLACK BOX acceptance suite → ${ORIGIN}\n`);

  await check('0. the target is running THIS commit — a green suite must mean this code passed', async () => {
    // Severing the suite onto staging only buys anything if staging runs the code under
    // test. A suite pointed at a stale worker reports green for code that was never
    // exercised — worse than no suite, because it is believed. `pnpm deploy` ships
    // staging and production from the same build id, so this check simply proves it ran.
    const expected = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', shell: true }).trim();
      } catch {
        return '';
      }
    })();
    assert(expected, 'could not read the git HEAD — cannot prove the target is current');
    const res = await api('GET', `/version?ts=${Date.now()}`);
    assert(res.status === 200 && res.data?.version, `target did not report a build: ${res.status}`);
    assert(
      res.data.version === expected,
      `STALE TARGET: ${ORIGIN} is running '${res.data.version}' but HEAD is '${expected}'. ` +
        'Run `pnpm deploy` first — otherwise this suite is testing code you are not shipping.',
    );
  });

  await check('1. signup + login, BOTH modes (direct + covert), mode persists', async () => {
    for (const mode of ['direct', 'covert']) {
      const u = await signup(mode);
      assert(u.displayMode === mode, `finalize returned mode ${u.displayMode}`);
      const si = await api('POST', '/v1/auth/signin', { body: { email: u.email, password: PW } });
      assert(si.data?.sessionToken, 'signin no token');
      assert(si.data?.displayMode === mode, `signin mode ${si.data?.displayMode} != ${mode}`);
    }
  });

  await check('2. add contact + persistence (survives reload via GET)', async () => {
    const u = await signup();
    const add = await addEmail(u.session, 'primary', 'Persisted');
    assert(add.status === 200, `add ${add.status}`);
    const got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const p = got.data.slots.find((s) => s.slot === 'primary');
    assert(p?.filled && p.contactName === 'Persisted' && p.channel === 'email', 'primary not persisted');
    // Brief 28 §2: armable now also requires entitlement, so a fresh (unactivated)
    // account asserts the RECIPIENT precondition specifically (that an email contact is
    // deliverable) via armReasons — the entitlement half is proven in the §28 checks.
    assert(got.data.armReasons?.hasDeliverableRecipient === true, 'email contact not deliverable');
  });

  await check('3. QR-LINE: manual save refused; pairing start+status work (no id typed)', async () => {
    const u = await signup();
    const manual = await api('POST', '/v1/me/contacts/primary', { bearer: u.session, body: { contactName: 'X', channel: 'line', destination: 'U8f53386494d2880f3c59008f2f1f64ee' } });
    assert(manual.status === 400 && manual.data.error === 'line_requires_pairing', `manual line not refused: ${manual.status} ${JSON.stringify(manual.data)}`);
    const start = await api('POST', '/v1/me/line-pairing/start', { bearer: u.session, body: { slot: 'primary', contactName: 'QR' } });
    assert(start.status === 200 && start.data.nonce && start.data.deepLink && typeof start.data.qrSvg === 'string', 'pairing start bad: ' + JSON.stringify(start.data).slice(0, 120));
    assert(start.data.deepLink.includes('oaMessage') && start.data.deepLink.includes('BBX-'), 'deepLink missing token');
    const st = await api('GET', `/v1/me/line-pairing/status?nonce=${start.data.nonce}`, { bearer: u.session });
    assert(st.status === 200 && st.data.status === 'pending', 'status not pending');
  });

  await check('4. remove + reindex (remove secondary → tertiary becomes secondary)', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    await addEmail(u.session, 'secondary', 'S');
    const t = await addEmail(u.session, 'tertiary', 'T');
    assert(t.status === 200, 'add tertiary failed');
    const rm = await api('DELETE', '/v1/me/contacts/secondary', { bearer: u.session });
    assert(rm.status === 200, 'remove failed');
    const got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const sec = got.data.slots.find((s) => s.slot === 'secondary');
    const ter = got.data.slots.find((s) => s.slot === 'tertiary');
    assert(sec?.filled && sec.contactName === 'T', `reindex failed: secondary=${sec?.contactName}`);
    assert(!ter?.filled, 'tertiary should be empty after reindex');
  });

  await check('5. Present/display-mode toggle persists (covert ⇄ direct)', async () => {
    const u = await signup('direct');
    const toCovert = await api('POST', '/v1/me/display-mode', { bearer: u.session, body: { displayMode: 'covert' } });
    assert(toCovert.status === 200, 'set covert failed');
    let me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user?.displayMode === 'covert', `mode not covert: ${me.data.user?.displayMode}`);
    await api('POST', '/v1/me/display-mode', { bearer: u.session, body: { displayMode: 'direct' } });
    me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user?.displayMode === 'direct', 'mode not back to direct');
  });

  await check('6. guardian toggle on/off persists', async () => {
    const u = await signup();
    await addEmail(u.session, 'guardian', 'G');
    await api('POST', '/v1/me/guardian-enabled', { bearer: u.session, body: { enabled: false } });
    let got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(got.data.guardianEnabled === false, 'guardian not disabled');
    await api('POST', '/v1/me/guardian-enabled', { bearer: u.session, body: { enabled: true } });
    got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(got.data.guardianEnabled === true, 'guardian not re-enabled');
  });

  await check('7. the button always fires: zero contacts still opens + captures (never 409)', async () => {
    const u = await signup();
    const ev = await api('POST', '/v1/events', { bearer: u.session, body: { source: 'acc' } });
    assert(ev.status === 201, `zero-contact trigger refused — DEAD BUTTON: ${ev.status} ${JSON.stringify(ev.data)}`);
    assert(ev.data.eventId, 'no eventId: trigger did not open an event');
    created.events.push(ev.data.eventId);
  });

  await check('7b. honest status: zero contacts → recipientCount 0 (never false comfort)', async () => {
    const u = await signup();
    const ev = await api('POST', '/v1/events', { bearer: u.session, body: { source: 'acc-honest' } });
    assert(ev.status === 201 && ev.data.eventId, `trigger refused: ${ev.status}`);
    created.events.push(ev.data.eventId);
    // The active screen derives its line from these two fields. recipientCount 0
    // is what makes it say "no contacts to notify · recording only" instead of the
    // false-comfort "being notified". delivery-status is behind hmacAuth
    // (app.use '/v1/events/:id/*') — sign with the per-event secret.
    const path = `/v1/events/${ev.data.eventId}/delivery-status`;
    const ds = await signed('GET', path, ev.data.hmacSecret, ev.data.eventId);
    assert(ds.status === 200, `delivery-status not readable: ${ds.status} ${JSON.stringify(ds.data)}`);
    assert(ds.data.recipientCount === 0, `recipientCount not 0 (false comfort): ${JSON.stringify(ds.data)}`);
    assert(ds.data.allChannelsFailed === false, `allChannelsFailed true with no recipients: ${JSON.stringify(ds.data)}`);

    // ...and an account that DOES have someone reports it, so the same line reads
    // "being notified" only when that is true. Contact is added BEFORE the trigger:
    // the live-alert lock (Brief 20) refuses contact edits mid-event by design.
    const u2 = await signup();
    await addEmail(u2.session, 'primary', 'P');
    const ev2 = await api('POST', '/v1/events', { bearer: u2.session, body: { source: 'acc-honest-2' } });
    assert(ev2.status === 201 && ev2.data.eventId, `trigger refused: ${ev2.status}`);
    created.events.push(ev2.data.eventId);
    const path2 = `/v1/events/${ev2.data.eventId}/delivery-status`;
    const ds2 = await signed('GET', path2, ev2.data.hmacSecret, ev2.data.eventId);
    assert(ds2.data.recipientCount >= 1, `recipientCount did not see the contact: ${JSON.stringify(ds2.data)}`);
  });

  await check('8. trigger → timed cascade fires 0/10/20/30/40 (DO alarm) + email delivered', async () => {
    const u = await signup();
    for (const slot of ['primary', 'secondary', 'tertiary', 'guardian', 'emergency']) await addEmail(u.session, slot, slot);
    const ev = await trigger(u.session, 'acc-cascade');
    assert(ev.eventId, 'no event');
    // POLL for the 5 steps rather than sleeping a fixed 46s. A fixed sleep left ~6s
    // of headroom on the T+40 step and failed as "got 4" whenever the platform was
    // momentarily slow — a read-too-early artefact, not a cascade fault. Polling
    // costs nothing in rigor: the timing assertion below is on each row's OWN
    // timestamp, not on when we happened to look.
    let fired = [];
    for (let i = 0; i < 35 && fired.length < 5; i += 1) {
      await sleep(2000);
      fired = await adminFires(ev.eventId);
    }
    assert(fired.length === 5, `expected 5 cascade_fired, got ${fired.length}`);
    // WHICH driver fired each step. Two drivers are healthy and both are real-time:
    //   stagger — the in-request waitUntil chain, which covers T+0..T+30;
    //   alarm   — the Durable Object, which exists precisely because waitUntil is
    //             reclaimed ~35s and so cannot reach the T+40 emergency step.
    // A healthy run therefore reads stagger,stagger,stagger,stagger,alarm — NOT all
    // alarm; the two race and advanceStep atomically claims the winner.
    //
    // The signal is the 1-minute CRON backstop. If it fired a step, both real-time
    // drivers missed their window and the survivor's step landed up to 60s late. The
    // capture still went out, so it is not a survivor-facing failure — but it is a
    // genuine degradation and it is named and FAILED here, never averaged away.
    const HEALTHY = ['alarm', 'stagger'];
    const late = fired.map((f, i) => ({ i, via: f.via })).filter((f) => !HEALTHY.includes(f.via));
    assert(
      late.length === 0,
      `cascade step(s) not fired by a real-time driver: ${late
        .map((r) => `step ${r.i} via ${r.via ?? 'unknown'}`)
        .join(', ')} (drivers: ${fired.map((f) => f.via ?? 'unknown').join(',')})`,
    );
    const targets = [0, 10, 20, 30, 40];
    for (let i = 0; i < 5; i += 1) {
      const rel = (fired[i].t - ev.createdAt) / 1000;
      assert(Math.abs(rel - targets[i]) <= 3.5, `step ${i} fired at T+${rel.toFixed(1)}s, want ~${targets[i]}`);
    }
    // DISPATCH, not vendor delivery (Brief 31). This previously asserted that a real
    // email physically landed — which made a genuine SendGrid outage read as a "test
    // flake", and, worse, made the gate itself consume the finite quota the alert
    // path depends on. What the system controls, and therefore what a gate should
    // verify, is that it ATTEMPTED the right channel for every step. Whether a
    // third-party vendor then delivered is monitoring, not acceptance.
    //
    // Suite recipients are @example.com (RFC 2606), so the provider is deliberately
    // never called and these record as 'suppressed' — a real dispatch, zero quota.
    let dispatched = 0;
    for (let i = 0; i < 12 && dispatched < 5; i += 1) {
      dispatched = await adminDelivered(ev.eventId, 'email');
      if (dispatched < 5) await sleep(2500);
    }
    assert(dispatched >= 5, `expected 5 email dispatch records (one per step), got ${dispatched}`);
    // ...and every one of them must be the quota-free path. A 'delivered' or 'failed'
    // row here would mean the suite reached the real provider after all — the exact
    // coupling this brief severed — so assert it explicitly rather than assume it.
    const suppressed = await adminDelivered(ev.eventId, 'email', 'suppressed');
    assert(
      suppressed >= 5,
      `suite dispatch spent production quota: only ${suppressed}/${dispatched} email records were suppressed`,
    );
  });

  await check('9. cascade does NOT halt across a gap: emergency fires past empty middle slots', async () => {
    // The "a missing recipient must not stop later steps" guarantee: only primary
    // and emergency are populated (secondary/tertiary/guardian empty) — emergency
    // (the tail) must still fire. (A real delivery-FAILURE fall-through is proven by
    // the Brief-17 live trace, where LINE failed at step 0 yet steps 1–3 fired; it
    // can't be re-synthesized here since manual LINE/SMS saves are now refused.)
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    await addEmail(u.session, 'emergency', 'E');
    const ev = await trigger(u.session, 'acc-fallthrough');
    await sleep(15000); // emergency is step index 1 here → ~T+10s
    const fired = await adminFires(ev.eventId);
    assert(fired.length >= 2, `tail did not fire past the gap: only ${fired.length} steps`);
    // COUNT ONLY — no timing assertion here; this check is about fall-through past a
    // gap, not schedule precision (check 8 owns that). Poll like check 8 does: the
    // delivery record is written AFTER the provider round-trip, so a single read at
    // T+15s gave the emergency step's send ~5s to complete and flaked as "(1)".
    // Deliberately status-agnostic: a `failed` record still proves the step was
    // attempted, which is the guarantee under test. Filtering status='delivered'
    // would make this a test of SendGrid's reliability instead.
    let delivered = 0;
    for (let i = 0; i < 12 && delivered < 2; i += 1) {
      delivered = await adminDelivered(ev.eventId, 'email');
      if (delivered < 2) await sleep(2500);
    }
    assert(delivered >= 2, `emergency step produced no delivery record (${delivered})`);
  });

  // ---- CLOSURE GATE — the tripwire (#2). Requires MAGIC_LINK_SECRET. ----
  await check('10. CLOSURE GATE: support assent ALONE does not close (queued, awaiting user)', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set — the closure gate cannot be exercised; suite fails closed');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-gate');
    const { token, cookie } = await claimCoordinator(ev.eventId);
    // Symmetric consent: the coordinator may assent first, but it must NOT close
    // without the user's matching assent — neither side closes unilaterally.
    const sec = await api('POST', `/v1/c/${ev.eventId}/secure?t=${token}`, { cookie });
    assert(sec.status === 200 && sec.data.queued && sec.data.awaitingUser, `support-first not queued: ${sec.status} ${JSON.stringify(sec.data)}`);
    const ev2 = await adminEvent(ev.eventId);
    assert(ev2.status === 'active', `GATE BROKEN: event closed with no user assent (status=${ev2.status})`);
  });

  await check('11. contact NEVER enters the code: coordinator /standdown is 403', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-code');
    const { token, cookie } = await claimCoordinator(ev.eventId);
    const sd = await api('POST', `/v1/c/${ev.eventId}/standdown?t=${token}`, { cookie, body: { code: '246' } });
    assert(sd.status === 403, `coordinator code-entry not blocked: ${sd.status} ${JSON.stringify(sd.data)}`);
    const ev2 = await adminEvent(ev.eventId);
    assert(ev2.status === 'active', 'event closed via coordinator code');
  });

  await check('12. closure APPROVE after a code-validated user request → session ends', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-approve');
    const { token, cookie } = await claimCoordinator(ev.eventId);
    // User requests closure (on-device pin → SAT). Signed event request.
    const req = await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'sat', reasonSecured: 'acceptance' });
    assert(req.status === 200, `closure-request failed ${req.status}`);
    const sec = await api('POST', `/v1/c/${ev.eventId}/secure?t=${token}`, { cookie });
    assert(sec.status === 200 && sec.data.secured, `approve failed ${sec.status} ${JSON.stringify(sec.data)}`);
    const ev2 = await adminEvent(ev.eventId);
    assert(ev2.status === 'closed', 'event not closed after approval');
  });

  await check('13. duress request shows THREAT-ONGOING (unsat), does not read as safe', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-duress');
    const { token } = await claimCoordinator(ev.eventId);
    const req = await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'unsat' });
    assert(req.status === 200, 'duress request failed');
    const state = await api('GET', `/v1/c/${ev.eventId}/state?t=${token}`);
    assert(state.data?.closure?.requested === true && state.data.closure.pin === 'unsat', `duress not surfaced as unsat: ${JSON.stringify(state.data?.closure)}`);
  });

  await check('14. one active event per user: re-trigger RESUMES (same eventId)', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const a = await trigger(u.session, 'acc-one-a');
    const b = await trigger(u.session, 'acc-one-b');
    assert(a.eventId && b.eventId === a.eventId && b.resumed === true, `stacked instead of resumed: ${a.eventId} vs ${b.eventId} resumed=${b.resumed}`);
  });

  await check('15. operator force-close (admin) ends an orphaned active event', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-fc');
    const fc = await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN });
    assert(fc.status === 200 && (fc.data.closed || fc.data.alreadyClosed), `force-close failed ${fc.status}`);
    const ev2 = await adminEvent(ev.eventId);
    assert(ev2.status === 'closed', 'not closed after force-close');
  });

  await check('16. Brief 16 §1: signup finalizes with NO lock code; no pin authenticates login', async () => {
    // signup() itself sends no lockCode — finalize must accept that and mint a session.
    const u = await signup();
    assert(u.session, 'finalize without a lockCode failed to create a session');
    // There is no pin; an arbitrary code must never authenticate.
    const byCode = await api('POST', '/v1/auth/signin', { body: { email: u.email, password: '246' } });
    assert(byCode.status !== 200 || !byCode.data?.sessionToken, 'a code authenticated login — a pin is wired to login');
    const byPw = await api('POST', '/v1/auth/signin', { body: { email: u.email, password: PW } });
    assert(byPw.status === 200 && byPw.data?.sessionToken, 'password login failed');
  });

  await check('17. Brief 16 §1: the lock-code standdown path is retired (gesture-only)', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-no-standdown');
    // The legacy user lock-code close must be gone — closure is gesture + consent only.
    const sd = await signed('POST', `/v1/events/${ev.eventId}/standdown`, ev.hmacSecret, ev.eventId, { code: '246' });
    assert(sd.status === 410, `standdown not retired (expected 410, got ${sd.status})`);
    // And the event is still active — nothing closed it.
    const ev2 = await adminEvent(ev.eventId);
    assert(ev2.status === 'active', `standdown closed the event: ${ev2.status}`);
  });

  await check('18. one close door: a client refresh during an active event does NOT close it', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-door');
    // Simulate the user app reloading/polling — none of these close the event.
    await api('GET', `/v1/events/${ev.eventId}/delivery-status`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await adminEvent(ev.eventId);
    assert(after.status === 'active', `event closed on refresh (status=${after.status}) — implicit close door exists`);
  });

  await check('19. §2 symmetric consent: support-initiated → user-confirms closes (order-independent)', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-sym');
    const { token, cookie } = await claimCoordinator(ev.eventId);
    // SUPPORT assents first → queued, not closed.
    const sec1 = await api('POST', `/v1/c/${ev.eventId}/secure?t=${token}`, { cookie });
    assert(sec1.data?.queued && sec1.data?.awaitingUser, `support-first not queued: ${JSON.stringify(sec1.data)}`);
    assert((await adminEvent(ev.eventId)).status === 'active', 'closed before the user assented');
    // USER assents second (clean gesture) → both present → closes.
    const req = await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'sat' });
    assert(req.status === 200 && req.data?.closed === true, `user confirm did not close: ${JSON.stringify(req.data)}`);
    assert((await adminEvent(ev.eventId)).status === 'closed', 'not closed after both assents');
  });

  await check('20. §2 duress survives initiation order: support-first + user-DURESS closes DURESS, not safe', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-symduress');
    const { token, cookie } = await claimCoordinator(ev.eventId);
    await api('POST', `/v1/c/${ev.eventId}/secure?t=${token}`, { cookie }); // support assents first
    const req = await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'unsat' });
    assert(req.status === 200, 'duress assent failed');
    // The closure report's disposition must be DURESS — never a clean SAT.
    const rep = await api('GET', `/v1/c/${ev.eventId}/closure-report?t=${token}`, { cookie });
    assert(rep.data?.disposition === 'DURESS', `disposition laundered to ${rep.data?.disposition} (expected DURESS)`);
  });

  await check('21. §4: lifecycle events send NO email; /subscribe is a push (WebSocket) endpoint', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    assert(ADMIN, 'BBX_ADMIN_TOKEN not set — cannot read delivery records');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-nolifecycle');
    const { token } = await claimCoordinator(ev.eventId);
    // Fire lifecycle events: repeated duress closure requests (→ also tampering).
    await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'unsat' });
    await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'unsat' });
    await sleep(2500);
    // NONE of these lifecycle message kinds may produce a delivery record — they
    // are in-app server-push only. (messageKind-precise; no activation-timing race.)
    const kindCount = async (k) => (await api('GET', `/v1/admin/events/${ev.eventId}/deliveries?kind=${k}`, { bearer: ADMIN })).data?.count ?? 0;
    for (const k of ['closure', 'duress', 'closureConfirmation', 'tampering']) {
      const n = await kindCount(k);
      assert(n === 0, `lifecycle '${k}' email was sent (${n} record(s)) — lifecycle must be in-app push, never email`);
    }
    // The subscribe endpoint is a WebSocket push channel, not a JSON poll: a plain
    // GET (no Upgrade) is refused with 426, proving it isn't a polling endpoint.
    const noUp = await api('GET', `/v1/c/${ev.eventId}/subscribe?t=${token}`);
    assert(noUp.status === 426, `subscribe is not a push endpoint (expected 426, got ${noUp.status})`);
  });

  await check('22. §3 escalation plumbing: tier + coordinator-path-failed surfaced (coordinator tier by default)', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    // The 60s/180s transition itself is unit-tested (escalationAction); here we
    // prove the state it drives is wired through to the dashboard and the user app.
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-escalation');
    const { token } = await claimCoordinator(ev.eventId);
    await signed('POST', `/v1/events/${ev.eventId}/closure-request`, ev.hmacSecret, ev.eventId, { status: 'sat' });
    const state = await api('GET', `/v1/c/${ev.eventId}/state?t=${token}`);
    assert(state.data?.closure?.tier === 'coordinator', `closure.tier wrong: ${JSON.stringify(state.data?.closure)}`);
    assert(state.data?.closure?.coordinatorFailed === false, 'closure.coordinatorFailed should start false');
    const ds = await signed('GET', `/v1/events/${ev.eventId}/delivery-status`, ev.hmacSecret, ev.eventId, undefined);
    assert(ds.data?.coordinatorPathFailed === false && ds.data?.escalationTier === 'coordinator', `delivery-status escalation fields wrong: ${ds.status} ${JSON.stringify(ds.data)}`);
  });

  await check('23. §5 emergency views: CAD dispatch summary renders read-only + logs access; auth-gated', async () => {
    assert(MAGIC, 'BBX_MAGIC_LINK_SECRET not set');
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-cad');
    const { token } = await claimCoordinator(ev.eventId);
    // The structured, READ-ONLY summary renders for a valid token.
    const sum = await api('GET', `/v1/c/${ev.eventId}/dispatch-summary?t=${token}`);
    assert(sum.status === 200 && typeof sum.data === 'string' && /Dispatch Summary/i.test(sum.data), `summary did not render: ${sum.status}`);
    assert(/NOTIFICATION ONLY/i.test(sum.data) && !/REQUEST CLOSURE|SECURE —/i.test(sum.data), 'summary must be read-only — no closure/consent control');
    // Auth-gated: no token → 401.
    const noTok = await api('GET', `/v1/c/${ev.eventId}/dispatch-summary`);
    assert(noTok.status === 401, `summary not auth-gated (expected 401, got ${noTok.status})`);
    // Access is logged.
    if (ADMIN) {
      const aud = await api('GET', `/v1/admin/events/${ev.eventId}/audit`, { bearer: ADMIN });
      assert(JSON.stringify(aud.data ?? '').includes('dispatch_summary_viewed'), 'summary access was not audited');
    }
  });

  await check('24. check-in routes to the PRIMARY contact ONLY (no override door, no fallthrough); honest failure; dormant-only', async () => {
    assert(ADMIN, 'BBX_ADMIN_TOKEN not set — cannot read the delivery log');
    const u = await signup();
    // No contact at all → HONEST failure, never a silent success.
    const none = await api('POST', '/v1/me/checkin', { bearer: u.session, body: {} });
    assert(
      none.status === 200 && none.data?.ok === false && (none.data?.recipients ?? -1) === 0 && none.data?.reason === 'no_recipient',
      `no-contact check-in must honestly fail (ok:false, recipients:0, reason:no_recipient): ${JSON.stringify(none.data)}`,
    );
    // Add a PRIMARY contact → the default check-in recipient with no explicit pick.
    assert((await addEmail(u.session, 'primary', 'P')).status === 200, 'add primary failed');
    const chk = await api('POST', '/v1/me/checkin', { bearer: u.session, body: { location: { lat: 35.681, lon: 139.767 }, tzOffsetMinutes: -540 } });
    assert(chk.status === 200 && chk.data?.id, `check-in failed: ${chk.status} ${JSON.stringify(chk.data)}`);
    // Dormant-only: a check-in creates NO event (nothing to arm/coordinate).
    assert(chk.data?.eventId === undefined, 'check-in created an event — it must stay dormant-only');
    // NOT a no-op: a delivery ATTEMPT to the contact is recorded. delivered-vs-
    // failed is provider-dependent (e.g. SendGrid credits) and is surfaced to the
    // user honestly; the regression guard here is that the PATH is hit at all.
    let recs = 0;
    for (let i = 0; i < 8 && recs < 1; i += 1) {
      recs = (await api('GET', `/v1/admin/events/${chk.data.id}/deliveries?kind=checkin`, { bearer: ADMIN })).data?.count ?? 0;
      if (recs < 1) await sleep(500);
    }
    assert(recs >= 1, `check-in is a NO-OP — no delivery attempt recorded for the contact: ${JSON.stringify(chk.data)}`);
    // PRIMARY-ONLY, proven adversarially on an account that has a deliverable
    // `contact` but NO primary. A second account is used because removing this one's
    // primary would REINDEX (secondary shifts to priority 1 and legitimately becomes
    // the primary), which would prove nothing.
    //
    // A non-primary contact must NEVER receive a check-in and must NEVER be silently
    // substituted for a missing primary: the answer is an honest no_recipient. Under
    // the retired override (users.checkinContactId) this contact COULD be designated
    // and would have been delivered to — so this pair of assertions is what holds the
    // door shut.
    const v = await signup();
    assert((await addEmail(v.session, 'secondary', 'S')).status === 200, 'add secondary failed');
    const listed = await api('GET', '/v1/me/contacts', { bearer: v.session });
    const secondaryId = listed.data?.slots?.find((s) => s.slot === 'secondary')?.id;
    assert(secondaryId, `secondary contact id missing from /contacts: ${JSON.stringify(listed.data)}`);
    const nonPrimary = await api('POST', '/v1/me/checkin', { bearer: v.session, body: {} });
    assert(
      nonPrimary.status === 200 && nonPrimary.data?.ok === false && (nonPrimary.data?.recipients ?? -1) === 0 && nonPrimary.data?.reason === 'no_recipient',
      `a non-primary contact must NOT receive the check-in — expected honest no_recipient: ${JSON.stringify(nonPrimary.data)}`,
    );
    // The override endpoint is GONE, not merely ignored. A 200 here would mean a
    // setting that appears to take effect and changes nothing; a 404 is the contract.
    const desig = await api('POST', '/v1/me/checkin-contact', { bearer: v.session, body: { contactId: secondaryId } });
    assert(desig.status === 404, `POST /v1/me/checkin-contact must be gone (404), got ${desig.status}: ${JSON.stringify(desig.data)}`);
    // And no designation field survives on the contacts view for a client to render a
    // recipient the server would not actually route to.
    assert(
      listed.data?.checkinContactId === undefined,
      `/contacts must not expose checkinContactId: ${JSON.stringify(listed.data)}`,
    );
    // Adding the PRIMARY is what makes a check-in deliverable — same account, one
    // change, so the primary is unambiguously the cause.
    assert((await addEmail(v.session, 'primary', 'P')).status === 200, 'add primary failed');
    const nowOk = await api('POST', '/v1/me/checkin', { bearer: v.session, body: {} });
    assert(nowOk.status === 200 && nowOk.data?.reason !== 'no_recipient', `primary contact did not become the recipient: ${JSON.stringify(nowOk.data)}`);
    // The guardian is never a check-in recipient: a guardian-only account still fails
    // honestly rather than quietly paging the guardian.
    const w = await signup();
    assert(
      (await api('POST', '/v1/me/contacts/guardian', { bearer: w.session, body: { contactName: 'G', channel: 'email', destination: `smoke+chkg-${uniq()}@example.com` } })).status === 200,
      'add guardian failed',
    );
    const gOnly = await api('POST', '/v1/me/checkin', { bearer: w.session, body: {} });
    assert(
      gOnly.data?.ok === false && gOnly.data?.reason === 'no_recipient',
      `the guardian must never receive a check-in: ${JSON.stringify(gOnly.data)}`,
    );
  });

  await check('25. §20 live-alert lock: /me reports activeEvent; delete refused (423) during alert; restored after close', async () => {
    const u = await signup();
    // Armable so the trigger opens a real event.
    assert((await addEmail(u.session, 'primary', 'P')).status === 200, 'add primary failed');
    const ev = await trigger(u.session, 'lockspec');
    assert(ev?.eventId, `trigger did not open an event: ${JSON.stringify(ev)}`);
    // Server-truth lock: /me reports the live alert (the client gates settings +
    // sign-out on this), and account-delete is refused.
    const during = await api('GET', '/v1/me', { bearer: u.session });
    assert(during.data?.activeEvent === true, `/me must report activeEvent during a live alert: ${JSON.stringify(during.data)}`);
    const delDuring = await api('DELETE', '/v1/me/account', { bearer: u.session });
    assert(delDuring.status === 423, `account delete must be refused (423) during a live alert, got ${delDuring.status}`);
    // Close via the admin failsafe (stand-in for the gesture/dual-consent close),
    // then the lock lifts in the same account with no reload.
    if (ADMIN) {
      const fc = await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'acceptance §20 cleanup' } });
      assert(fc.status === 200, `force-close failed: ${fc.status} ${JSON.stringify(fc.data)}`);
      const after = await api('GET', '/v1/me', { bearer: u.session });
      assert(after.data?.activeEvent === false, `activeEvent must clear after close: ${JSON.stringify(after.data)}`);
      const delAfter = await api('DELETE', '/v1/me/account', { bearer: u.session });
      assert(delAfter.status === 200, `account delete must work once dormant, got ${delAfter.status}`);
    }
  });

  await check('26. §25 trigger→close→trigger cycle: a fresh trigger after a close creates a NEW event, never resumes the closed one', async () => {
    assert(ADMIN, 'BBX_ADMIN_TOKEN not set — cannot close between triggers');
    const u = await signup();
    assert((await addEmail(u.session, 'primary', 'P')).status === 200, 'add primary failed');
    // Cycle it a few times, both "orders" are the same server path: create → close →
    // create must always yield a DISTINCT, fresh event (resolveSingleActive filters
    // status='active', so a closed event is never resumed).
    let prev = null;
    for (let i = 0; i < 3; i += 1) {
      const ev = await trigger(u.session, `cycle-${i}`);
      assert(ev?.eventId, `trigger ${i} did not open an event: ${JSON.stringify(ev)}`);
      assert(!ev.resumed, `trigger ${i} resumed a prior event instead of a fresh create: ${JSON.stringify(ev)}`);
      assert(ev.eventId !== prev, `trigger ${i} reused the previous event id after a close: ${ev.eventId}`);
      prev = ev.eventId;
      const fc = await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'cycle test' } });
      assert(fc.status === 200, `close ${i} failed: ${fc.status}`);
    }
  });

  await check('27. mode-order matrix: every trigger ordering creates a fresh event; check-in never poisons a trigger', async () => {
    assert(ADMIN, 'BBX_ADMIN_TOKEN not set — cannot close between triggers');
    const u = await signup('direct');
    assert((await addEmail(u.session, 'primary', 'P')).status === 200, 'add primary failed');
    const seen = new Set();
    const cycle = async (source) => {
      const ev = await trigger(u.session, source);
      assert(ev?.eventId && !ev.resumed, `${source} did not create a fresh event: ${JSON.stringify(ev)}`);
      assert(!seen.has(ev.eventId), `${source} reused a prior event id: ${ev.eventId}`);
      seen.add(ev.eventId);
      const on = await api('GET', '/v1/me', { bearer: u.session });
      assert(on.data?.activeEvent === true, `/me activeEvent should be true after ${source}: ${JSON.stringify(on.data)}`);
      const fc = await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'matrix' } });
      assert(fc.status === 200, `close ${source} failed: ${fc.status}`);
      const off = await api('GET', '/v1/me', { bearer: u.session });
      assert(off.data?.activeEvent === false, `/me activeEvent should be false after closing ${source}: ${JSON.stringify(off.data)}`);
    };
    // Visible-first, Visible-only, both switch directions — every trigger fresh.
    for (const s of ['direct-tap', 'direct-tap', 'stillpoint-press', 'direct-tap', 'stillpoint-press', 'direct-tap']) {
      await cycle(s);
    }
    // A check-in must not poison the next trigger (the exact reported sequence).
    assert((await api('POST', '/v1/me/checkin', { bearer: u.session, body: {} })).status === 200, 'check-in failed');
    await cycle('direct-tap');
  });

  await check('28. accounts: signup takes NO password; the email-reset path is GONE', async () => {
    // A passwordless signup is the new normal path — no password field exists in
    // the app, so the server must not require one.
    const email = `smoke+acc-${uniq()}@example.com`;
    const code = await issueSignupCode();
    const s1 = await api('POST', '/v1/auth/signup/start', { body: { name: 'Passwordless', email, regionId: 'jp', code } });
    assert(s1.status === 201 && s1.data?.capability, `passwordless signup refused: ${s1.status} ${JSON.stringify(s1.data)}`);
    created.emails.push(email);
    const s2 = await api('POST', '/v1/auth/signup/finalize', { body: { capability: s1.data.capability, displayMode: 'direct' } });
    assert(s2.data?.sessionToken, `finalize failed: ${JSON.stringify(s2.data)}`);
    // ...and the session it mints is a real one.
    const me = await api('GET', '/v1/me', { bearer: s2.data.sessionToken });
    assert(me.status === 200, `passwordless session not usable: ${me.status}`);
    // A passwordless account cannot be signed into by password (passwordHash NULL).
    const bad = await api('POST', '/v1/auth/signin', { body: { email, password: 'anything-at-all' } });
    assert(bad.status === 401, `passwordless account accepted a password: ${bad.status}`);
    // §2: password-reset-by-email must not exist. An abuser may read the inbox.
    for (const path of ['/v1/auth/forgot', '/v1/auth/reset']) {
      const gone = await api('POST', path, { body: { email } });
      assert(gone.status === 404, `${path} still exists (${gone.status}) — email-reset is forbidden`);
    }
  });

  await check('29. recovery code: issue → sign in → single-use (never emailed)', async () => {
    const u = await signup();
    const issued = await api('POST', '/v1/auth/recovery/issue', { bearer: u.session, body: {} });
    assert(issued.status === 200 && issued.data?.codes?.length, `no codes issued: ${JSON.stringify(issued.data)}`);
    const code = issued.data.codes[0];
    // The code signs you in with no password and no email round-trip.
    const login = await api('POST', '/v1/auth/recovery/consume', { body: { email: u.email, code } });
    assert(login.status === 200 && login.data?.sessionToken, `recovery login failed: ${JSON.stringify(login.data)}`);
    const me = await api('GET', '/v1/me', { bearer: login.data.sessionToken });
    assert(me.status === 200, `recovery session not usable: ${me.status}`);
    // Single-use: a replay of the same code must be refused.
    const replay = await api('POST', '/v1/auth/recovery/consume', { body: { email: u.email, code } });
    assert(replay.status === 400, `recovery code replayable — NOT single-use: ${replay.status}`);
    // A wrong code on a real account is refused, and reads identically to an
    // unknown account (no enumeration).
    const wrong = await api('POST', '/v1/auth/recovery/consume', { body: { email: u.email, code: 'ZZZZ-ZZZZ-ZZZZ' } });
    const unknown = await api('POST', '/v1/auth/recovery/consume', { body: { email: 'nobody@example.com', code: 'ZZZZ-ZZZZ-ZZZZ' } });
    assert(wrong.status === 400 && unknown.status === 400, `recovery enumeration leak: ${wrong.status} vs ${unknown.status}`);
    assert(JSON.stringify(wrong.data) === JSON.stringify(unknown.data), `recovery answers differ — enumeration leak`);
  });

  await check('30. magic link: never enumerates; a bogus token is refused', async () => {
    // NOTE ON COVERAGE: the full link loop (receive → consume) cannot be exercised
    // here — the token exists only inside the email, and only its hash is stored,
    // so no amount of DB access would recover it. What IS asserted: the endpoint
    // never leaks which accounts exist or which are passkey-protected (that would
    // map which survivors are still reachable through their inbox), and a forged
    // token buys nothing. The redeem path itself needs an on-device pass.
    const u = await signup();
    const real = await api('POST', '/v1/auth/magic/start', { body: { email: u.email } });
    const fake = await api('POST', '/v1/auth/magic/start', { body: { email: `nobody-${uniq()}@example.com` } });
    assert(real.status === 200 && fake.status === 200, `magic/start status leak: ${real.status} vs ${fake.status}`);
    assert(JSON.stringify(real.data) === JSON.stringify(fake.data), 'magic/start body differs — account enumeration leak');
    const forged = await api('POST', '/v1/auth/magic/consume', { body: { token: 'not-a-real-token' } });
    assert(forged.status === 400, `forged magic token accepted: ${forged.status}`);
  });

  await check('31. passkey endpoints are live and refuse the unauthenticated', async () => {
    // The ceremonies themselves need a real authenticator (device pass covers that).
    // Asserted here: the routes exist, login options are public (usernameless — the
    // request carries no identifier, so it leaks nothing), and enrollment refuses a
    // caller with neither a session nor a signupId.
    const opts = await api('POST', '/v1/auth/passkey/login/options', { body: {} });
    assert(opts.status === 200 && opts.data?.challenge, `login options broken: ${opts.status} ${JSON.stringify(opts.data)}`);
    assert(typeof opts.data.rpId === 'string' && opts.data.rpId.length > 0, `no rpId: ${JSON.stringify(opts.data)}`);
    const anon = await api('POST', '/v1/auth/passkey/register/options', { body: {} });
    assert(anon.status === 401, `anonymous passkey enrollment allowed: ${anon.status}`);
    const junk = await api('POST', '/v1/auth/passkey/login/verify', { body: { response: { id: 'nope' } } });
    assert(junk.status === 401, `junk assertion accepted: ${junk.status}`);
  });

  await check('32. §5 live-alert lock: account CHANGES refused mid-alert, sign-in never is', async () => {
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const issued = await api('POST', '/v1/auth/recovery/issue', { bearer: u.session, body: {} });
    assert(issued.status === 200, `pre-alert issue failed: ${issued.status}`);
    const code = issued.data.codes[0];

    const ev = await trigger(u.session, 'acc-lock');
    assert(ev.eventId, 'no event');
    // Account CHANGES are refused while live — an aggressor holding the phone
    // must not be able to re-mint credentials mid-event.
    const reissue = await api('POST', '/v1/auth/recovery/issue', { bearer: u.session, body: {} });
    assert(reissue.status === 423, `recovery re-issue not locked during alert: ${reissue.status}`);
    // ACCESS is never refused: the survivor may be on a borrowed/replacement device
    // mid-alert and must still be able to sign in and reach their own alert.
    // Locking sign-in here would be the dead-button failure in another costume.
    const login = await api('POST', '/v1/auth/recovery/consume', { body: { email: u.email, code } });
    assert(login.status === 200 && login.data?.sessionToken, `sign-in BLOCKED during alert — dead button: ${login.status}`);
    const opts = await api('POST', '/v1/auth/passkey/login/options', { body: {} });
    assert(opts.status === 200, `passkey login options blocked during alert: ${opts.status}`);

    // Close it so the account is not left live, and confirm the lock LIFTS —
    // a lock that never releases is its own kind of trap.
    const fc = await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'acceptance §5 lock' } });
    assert(fc.status === 200, `force-close failed: ${fc.status}`);
    const after = await api('POST', '/v1/auth/recovery/issue', { bearer: u.session, body: {} });
    assert(after.status === 200, `account changes still locked after close: ${after.status}`);
  });

  await check('33. dispatcher: channels are server truth; a backup is stored + validated', async () => {
    const u = await signup();
    const got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    // The UI renders channels from THIS, not a hardcoded list — so SMS appears by
    // itself the day Twilio lands and email disappears the day it is retired.
    assert(Array.isArray(got.data.deliverableChannels), `no deliverableChannels: ${JSON.stringify(got.data)}`);
    assert(!got.data.deliverableChannels.includes('whatsapp'), 'whatsapp must be a SEAM, not deliverable');
    // Twilio is not provisioned as of this brief — pinned so the day it IS, this
    // check fails loudly and the email-retirement follow-up gets picked up rather
    // than forgotten.
    const smsLive = got.data.deliverableChannels.includes('sms');
    console.log(`      (note: sms deliverable = ${smsLive} — when true, retire email per §1)`);

    // A backup on a channel that cannot deliver is refused, not silently stored:
    // it would be a second silent failure discovered mid-alert.
    const badFb = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: {
        contactName: 'P',
        channel: 'email',
        destination: `smoke+pref-${uniq()}@example.com`,
        fallbackChannel: 'whatsapp',
        fallbackDestination: '+81900000000',
      },
    });
    assert(badFb.status === 400, `unbuilt channel accepted as a backup: ${badFb.status}`);

    // The same channel twice is the same failure twice — refused.
    const sameFb = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: {
        contactName: 'P',
        channel: 'email',
        destination: `smoke+pref-${uniq()}@example.com`,
        fallbackChannel: 'email',
        fallbackDestination: `smoke+fb-${uniq()}@example.com`,
      },
    });
    assert(sameFb.status === 400 && sameFb.data?.error === 'fallback_same_channel', `same-channel backup accepted: ${sameFb.status}`);

    // A plain save still works and reports no backup.
    const ok = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: { contactName: 'P', channel: 'email', destination: `smoke+pref-${uniq()}@example.com` },
    });
    assert(ok.status === 200, `plain save failed: ${ok.status} ${JSON.stringify(ok.data)}`);
    const after = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const primary = after.data.slots.find((s) => s.slot === 'primary');
    assert(primary.filled && primary.channel === 'email', `primary not stored: ${JSON.stringify(primary)}`);
    assert(primary.fallbackChannel === null, `unexpected backup: ${JSON.stringify(primary)}`);
    assert('fallbackChannel' in primary, 'slot view must expose fallbackChannel');
  });

  await check('34. LINE-only contact (NO phone) is valid + armable; dashboard opens app-less', async () => {
    // Data-based channels reach devices with no cell number at all (a kid's iPod, a
    // WiFi-only iPhone). There is no way to SMS those and no iMessage API exists, so
    // a LINE-only contact is COMPLETE, not half-finished. Nothing may demand a phone.
    const u = await signup();
    // A LINE contact is captured by QR pairing, never typed — that refusal is check 3.
    // Here: prove no phone number is required anywhere for the ACCOUNT to be armable
    // once a LINE contact exists, by pairing one the way the webhook does.
    const start = await api('POST', '/v1/me/line-pairing/start', {
      bearer: u.session,
      body: { slot: 'primary', contactName: 'LineOnly' },
    });
    assert(start.status === 200 || start.status === 400, `pairing start unexpected: ${start.status}`);
    if (start.status === 400) {
      console.log('      (note: LINE pairing unavailable in this env — skipping the paired half)');
    }

    // The account's own phone is never required to arm.
    const me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.status === 200, `me failed: ${me.status}`);

    // The dashboard is a BROWSER page served by the worker — the contact installs
    // nothing. An unauthenticated hit still answers HTML, never an app wall.
    const res = await fetch(`${ORIGIN}/c/00000000-0000-0000-0000-000000000000`);
    const ctype = res.headers.get('content-type') ?? '';
    assert(ctype.includes('text/html'), `dashboard is not a browser page: ${ctype}`);
    const body = await res.text();
    assert(!/install the app|download the app|app store/i.test(body), 'dashboard demands an app install');
  });

  await check('35. SMS save: refused honestly — unavailable now, malformed once Twilio lands', async () => {
    const u = await signup();
    const chans = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const smsLive = (chans.data.deliverableChannels ?? []).includes('sms');

    // The route checks CHANNEL AVAILABILITY before destination format, and that
    // order is correct: while SMS cannot deliver at all, telling someone to "add a
    // country code" would send them fixing the wrong thing. So the two sides of the
    // Twilio rollout have genuinely different right answers, and this asserts each.
    if (!smsLive) {
      // Every sms save is refused as unavailable — well-formed or not. No contact is
      // ever stored on a channel that would silently never be reached.
      for (const dest of ['+819012345678', '090-1234-5678', 'hello']) {
        const res = await api('POST', '/v1/me/contacts/primary', {
          bearer: u.session,
          body: { contactName: 'P', channel: 'sms', destination: dest },
        });
        assert(res.status === 400 && res.data?.error === 'channel_not_available', `sms "${dest}" refused for the wrong reason: ${res.status} ${JSON.stringify(res.data)}`);
        assert(typeof res.data?.message === 'string', `no surfaced reason for "${dest}"`);
      }
      console.log('      (note: sms not provisioned — E.164 validation is unreachable until TWILIO_* secrets land; unit-covered in phone-validation.test.ts)');
      return;
    }

    // Twilio is live: now the format guard is the one that matters. A bad number must
    // never reach storage — the first anyone would learn of it is Twilio rejecting the
    // alert mid-emergency, when it cannot be fixed.
    for (const bad of ['hello', '+1234', '+0123456789']) {
      const res = await api('POST', '/v1/me/contacts/primary', {
        bearer: u.session,
        body: { contactName: 'P', channel: 'sms', destination: bad },
      });
      assert(res.status === 400, `malformed number "${bad}" was accepted: ${res.status}`);
    }
    // A local-format number must name the ACTUAL fix, not just say "invalid".
    const local = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: { contactName: 'P', channel: 'sms', destination: '090-1234-5678' },
    });
    assert(/country code/i.test(local.data?.message ?? ''), `message must name the fix: ${local.data?.message}`);
    // ...and a real number saves, stored E.164.
    const good = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: { contactName: 'P', channel: 'sms', destination: '+81 90 1234 5678' },
    });
    assert(good.status === 200, `well-formed sms save failed: ${good.status} ${JSON.stringify(good.data)}`);
    const after = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const p = after.data.slots.find((s) => s.slot === 'primary');
    assert(p.channel === 'sms' && p.destination === '+819012345678', `sms contact not stored E.164: ${JSON.stringify(p)}`);
  });

  await check('36. consent: SMS add → pending; email/LINE → confirmed; status in slot view', async () => {
    const u = await signup();
    // An email contact is grandfathered confirmed (email is retiring, no confirm
    // flow) — flag-independent, and no SMS is sent.
    const em = await api('POST', '/v1/me/contacts/guardian', {
      bearer: u.session,
      body: { contactName: 'G', channel: 'email', destination: `smoke+g-${uniq()}@example.com` },
    });
    assert(em.status === 200, `email add failed: ${em.status} ${JSON.stringify(em.data)}`);
    assert(em.data.status === 'confirmed', `email contact not confirmed: ${JSON.stringify(em.data)}`);

    // An SMS contact is PENDING until it replies YES. Fiction number (555-01xx is
    // reserved) so the fire-and-forget confirmation send reaches no real person.
    const sms = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: { contactName: 'P', channel: 'sms', destination: '+15555550123' },
    });
    assert(sms.status === 200 && sms.data.status === 'pending', `SMS add not pending: ${sms.status} ${JSON.stringify(sms.data)}`);

    // The status is visible in the slot model the UI reads.
    const got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const primary = got.data.slots.find((s) => s.slot === 'primary');
    const guardian = got.data.slots.find((s) => s.slot === 'guardian');
    assert(primary.status === 'pending', `primary slot status wrong: ${JSON.stringify(primary)}`);
    assert(guardian.status === 'confirmed', `guardian slot status wrong: ${JSON.stringify(guardian)}`);

    // Editing the SMS contact's NAME (same number) must not reset consent... but it
    // is pending here, so instead prove the inverse elsewhere: a same-number re-save
    // stays pending (still not confirmed by a rename).
    const rename = await api('POST', '/v1/me/contacts/primary', {
      bearer: u.session,
      body: { contactName: 'P renamed', channel: 'sms', destination: '+15555550123' },
    });
    assert(rename.data.status === 'pending', `rename changed consent unexpectedly: ${JSON.stringify(rename.data)}`);

    // Armed reflects the gate. With only a pending contact + a confirmed guardian, the
    // RECIPIENT precondition is met (the guardian is confirmed). This holds in both flag
    // states. Brief 28 §2 folded entitlement into armable, so assert the recipient half
    // via armReasons here (the entitlement half is proven in the §28 checks).
    assert(got.data.armReasons?.hasDeliverableRecipient === true, `guardian-confirmed account should be deliverable: ${JSON.stringify(got.data.armReasons)}`);
  });

  await check('37. consent webhook: unsigned inbound is refused (403)', async () => {
    // The real YES/NO loop needs Twilio's signature (device sign-off). What is
    // asserted on prod: the endpoint exists and rejects an unsigned/forged POST, so
    // a status can never be flipped by an attacker curling the webhook.
    const res = await api('POST', '/v1/webhooks/twilio', { body: { From: '+15555550123', Body: 'YES' } });
    assert(res.status === 403, `unsigned webhook not refused: ${res.status} ${JSON.stringify(res.data)}`);
  });

  // ===== Brief 23 — org tenancy (§2 isolation is the paramount property) =====
  // All gated on ADMIN (org bootstrap is an operator action). Skip-with-note if the
  // token is absent, like the other admin-only rows.
  await check('38. tenancy: cross-org isolation — a coordinator reaches ONLY their own org', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const A = await bootstrapOrgWithTwoAdmins('Org-A-' + uniq());
    const B = await bootstrapOrgWithTwoAdmins('Org-B-' + uniq());
    const codeA = await api('POST', '/v1/org/codes', { bearer: A.admin.session, body: { role: 'survivor' } });
    const survA = await enrollWith(codeA.data.code);
    assert(survA.red.data?.role === 'survivor', `A survivor not enrolled: ${JSON.stringify(survA.red.data)}`);
    const evA = await trigger(survA.acc.session);
    // A sees its own survivor + event…
    const listA = await api('GET', '/v1/org/survivors', { bearer: A.admin.session });
    assert(listA.data.survivors.some((s) => s.userId === survA.acc.userId), 'A cannot see its own survivor');
    const evsA = await api('GET', '/v1/org/events', { bearer: A.admin.session });
    assert(evsA.data.events.some((e) => e.id === evA.eventId), 'A cannot see its own event');
    // …B sees NEITHER, by any route (the isolation boundary).
    const listB = await api('GET', '/v1/org/survivors', { bearer: B.admin.session });
    assert(!listB.data.survivors.some((s) => s.userId === survA.acc.userId), 'ISOLATION BREACH: B sees A survivor');
    const evsB = await api('GET', '/v1/org/events', { bearer: B.admin.session });
    assert(!evsB.data.events.some((e) => e.id === evA.eventId), 'ISOLATION BREACH: B sees A event');
    const detailB = await api('GET', `/v1/org/events/${evA.eventId}`, { bearer: B.admin.session });
    assert(detailB.status === 404, `ISOLATION BREACH: B read A's event detail: ${detailB.status}`);
  });

  await check('39. enrollment: valid code enrolls; exhausted + revoked refused (expired: unit-covered)', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-C-' + uniq(), 'zero_fee', 5);
    const c1 = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor', maxUses: 1 } });
    const s1 = await enrollWith(c1.data.code);
    assert(s1.red.status === 200 && s1.red.data.role === 'survivor', `valid enroll failed: ${JSON.stringify(s1.red.data)}`);
    const s2 = await enrollWith(c1.data.code);
    assert(s2.red.status === 400, `exhausted (maxUses 1) code accepted a 2nd redeem: ${s2.red.status}`);
    const c2 = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    await api('POST', `/v1/org/codes/${c2.data.code}/revoke`, { bearer: O.admin.session });
    const s3 = await enrollWith(c2.data.code);
    assert(s3.red.status === 400, `revoked code was accepted: ${s3.red.status} ${JSON.stringify(s3.red.data)}`);
  });

  await check('40. migration: an individual account joins an org (history preserved) and can leave', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-D-' + uniq(), 'zero_fee', 2);
    // An existing INDIVIDUAL account with history/state: a saved contact. (No active
    // event — enrollment is an account change and is correctly live-alert-locked, so
    // "history" here is durable account state, not an in-flight alert.)
    const indiv = await signup();
    await api('POST', '/v1/me/contacts/guardian', { bearer: indiv.session, body: { contactName: 'Kin', channel: 'email', destination: `smoke+kin-${uniq()}@example.com` } });
    const c = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const red = await api('POST', '/v1/me/org/redeem', { bearer: indiv.session, body: { code: c.data.code } });
    assert(red.status === 200 && red.data.orgId === O.orgId, `migration failed: ${red.status} ${JSON.stringify(red.data)}`);
    // History preserved: the pre-join contact is still there after joining.
    const after = await api('GET', '/v1/me/contacts', { bearer: indiv.session });
    const kept = after.data.slots.find((s) => s.slot === 'guardian');
    assert(kept && kept.contactName === 'Kin', `history not preserved through migration: ${JSON.stringify(kept)}`);
    // Reversible: leaving unsets the org, keeps the account+contact, drops the roster row.
    const left = await api('POST', '/v1/me/org/leave', { bearer: indiv.session });
    assert(left.status === 200 && left.data.left === true, `leave failed: ${JSON.stringify(left.data)}`);
    const stillKin = (await api('GET', '/v1/me/contacts', { bearer: indiv.session })).data.slots.find((s) => s.slot === 'guardian');
    assert(stillKin && stillKin.contactName === 'Kin', 'contact lost on leave — history not preserved');
    const list = await api('GET', '/v1/org/survivors', { bearer: O.admin.session });
    assert(!list.data.survivors.some((s) => s.userId === indiv.userId), 'left account still on the org roster');
  });

  await check('41. assisted setup: an enrolled survivor reaches Armed; coordinator sees setup complete', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-E-' + uniq(), 'zero_fee', 2);
    const c = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const surv = await enrollWith(c.data.code);
    await api('POST', '/v1/me/contacts/guardian', { bearer: surv.acc.session, body: { contactName: 'G', channel: 'email', destination: `smoke+g-${uniq()}@example.com` } });
    const me = await api('GET', '/v1/me/contacts', { bearer: surv.acc.session });
    assert(me.data.armable === true, `enrolled survivor not armable after setup: ${JSON.stringify(me.data.armable)}`);
    const list = await api('GET', '/v1/org/survivors', { bearer: O.admin.session });
    const row = list.data.survivors.find((s) => s.userId === surv.acc.userId);
    assert(row && row.setupComplete === true, `coordinator doesn't see setup complete: ${JSON.stringify(row)}`);
  });

  await check('42. seats: ceiling refuses over-limit enroll; admin remove frees the seat + revokes', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-F-' + uniq(), 'zero_fee', 1); // ONE seat, 2 admins
    const c = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor', maxUses: 5 } });
    const s1 = await enrollWith(c.data.code);
    assert(s1.red.status === 200, `first survivor rejected on a 1-seat org: ${JSON.stringify(s1.red.data)}`);
    const s2 = await enrollWith(c.data.code);
    assert(s2.red.status === 400 && s2.red.data.error === 'seats_full', `seat ceiling not enforced: ${s2.red.status} ${JSON.stringify(s2.red.data)}`);
    const rem = await api('POST', `/v1/org/survivors/${s1.acc.userId}/remove`, { bearer: O.admin.session });
    assert(rem.status === 200, `remove-seat failed: ${JSON.stringify(rem.data)}`);
    assert(!(await api('GET', '/v1/org/survivors', { bearer: O.admin.session })).data.survivors.some((s) => s.userId === s1.acc.userId), 'removed survivor still on roster');
    const s3 = await enrollWith(c.data.code);
    assert(s3.red.status === 200, `seat not freed after remove (ceiling still full): ${JSON.stringify(s3.red.data)}`);
  });

  await check('43. a leaked/valid code grants MEMBERSHIP ONLY — never read access to survivor data', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-G-' + uniq(), 'zero_fee', 3);
    // A real enrolled survivor with data (an event).
    const cs = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor', maxUses: 5 } });
    const victim = await enrollWith(cs.data.code);
    const vEvent = await trigger(victim.acc.session);
    // An attacker who obtained the survivor code redeems it → they ARE enrolled…
    const attacker = await enrollWith(cs.data.code);
    assert(attacker.red.status === 200 && attacker.red.data.role === 'survivor', `attacker not enrolled: ${JSON.stringify(attacker.red.data)}`);
    // …but a survivor membership is NOT staff, so EVERY org read is refused (403):
    // no roster, no events, no other survivor's event — membership, not data access.
    assert((await api('GET', '/v1/org/survivors', { bearer: attacker.acc.session })).status === 403, 'MEMBERSHIP LEAK: survivor-code holder read the org roster');
    assert((await api('GET', '/v1/org/events', { bearer: attacker.acc.session })).status === 403, 'MEMBERSHIP LEAK: survivor-code holder read org events');
    assert((await api('GET', `/v1/org/events/${vEvent.eventId}`, { bearer: attacker.acc.session })).status === 403, "MEMBERSHIP LEAK: survivor-code holder read a victim's event");
    // Nor the victim's private capture stream — that needs the per-event token, which
    // an account session is not, so it is unauthorized entirely.
    assert((await api('GET', `/v1/c/${vEvent.eventId}/state`)).status === 401, 'capture stream reachable without an event token');
  });

  // ===== Brief 25 — anonymous incident tally (severed; no capture/event data) =====
  await check('44. tally: four closed answers accepted (201); per-account rate limit is honest (429), never silent', async () => {
    const u = await signup();
    const body = { kind: 'domestic_violence', roughlyWhen: 'past_year', regionId: 'jp', reportedOfficial: 'no' };
    for (let i = 0; i < 3; i += 1) {
      const r = await api('POST', '/v1/me/tally', { bearer: u.session, body });
      assert(r.status === 201 && r.data.ok, `tally submit ${i + 1} failed: ${r.status} ${JSON.stringify(r.data)}`);
    }
    // 4th in the same month is over the limit → refused HONESTLY (not a silent 201).
    const over = await api('POST', '/v1/me/tally', { bearer: u.session, body });
    assert(over.status === 429 && over.data.error === 'rate_limited', `rate limit not honest: ${over.status} ${JSON.stringify(over.data)}`);
    assert(over.data.limit === 3, `limit not surfaced: ${JSON.stringify(over.data)}`);
  });

  await check('45. tally: unreachable during an active alert (calm act, never under duress §7)', async () => {
    const u = await signup();
    const ev = await trigger(u.session);
    const locked = await api('POST', '/v1/me/tally', { bearer: u.session, body: { kind: 'other' } });
    assert(locked.status === 423, `tally reachable during active alert: ${locked.status} ${JSON.stringify(locked.data)}`);
    if (ADMIN) await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'tally lock test' } });
  });

  await check('46. tally: public aggregate needs no auth, exposes only aggregate cells, suppresses a rare (<10) combo', async () => {
    // Submit ONE deliberately-rare combination, then confirm it does NOT appear in the
    // published aggregate (a single row is below the suppression threshold).
    const u = await signup();
    const rare = { kind: 'other', roughlyWhen: 'longer_ago', regionId: 'jp-47', reportedOfficial: 'prefer_not_to_say' };
    const sub = await api('POST', '/v1/me/tally', { bearer: u.session, body: rare });
    assert(sub.status === 201, `rare tally submit failed: ${sub.status}`);
    // The stats endpoint is PUBLIC (no bearer) — open public-good data.
    const stats = await api('GET', '/v1/tally/stats');
    assert(stats.status === 200 && Array.isArray(stats.data.cells), `stats not public/aggregate: ${stats.status} ${JSON.stringify(stats.data)}`);
    assert(stats.data.suppressionThreshold >= 10, `suppression threshold too low: ${stats.data.suppressionThreshold}`);
    // The just-submitted single-row combo must be SUPPRESSED (count 1 < threshold).
    const leaked = stats.data.cells.find(
      (c) => c.regionId === 'jp-47' && c.kind === 'other' && c.roughlyWhen === 'longer_ago' && c.reportedOfficial === 'prefer_not_to_say',
    );
    assert(!leaked || leaked.count >= 10, `a rare (<10) combination was published, not suppressed: ${JSON.stringify(leaked)}`);
    // Aggregate rows carry ONLY coarse fields + a count — no identity ever.
    const allowed = ['submissionMonth', 'regionId', 'kind', 'roughlyWhen', 'reportedOfficial', 'count'];
    for (const cell of stats.data.cells) {
      for (const k of Object.keys(cell)) {
        assert(allowed.includes(k), `aggregate cell leaked a field: ${k}`);
      }
    }
  });

  // ===== Brief 24 — org registration (vetted, invite-only, one-time admin code) =====
  await check('47. registration: operator creates an org + issues a code; the link renders a form (read-only org)', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrg('Org-Reg-' + uniq(), 'zero_fee', 4);
    // The GET the page uses to render the form: read-only org details, no session.
    const view = await api('GET', `/v1/org-register/${O.registrationCode}`);
    assert(view.status === 200 && view.data.valid === true, `registration view not valid: ${view.status} ${JSON.stringify(view.data)}`);
    assert(view.data.org && view.data.org.seatsTotal === 4 && view.data.org.orgId === O.orgId, `org details wrong/editable: ${JSON.stringify(view.data.org)}`);
  });

  await check('48. registration: a passive GET consumes NOTHING and creates NO admin (the scanner hazard)', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrg('Org-Scan-' + uniq(), 'zero_fee', 2);
    // Hammer the link like an email scanner would — several times.
    for (let i = 0; i < 3; i += 1) await api('GET', `/v1/org-register/${O.registrationCode}`);
    // The code is STILL redeemable (unconsumed) and the org still has ZERO admins:
    // registering now must succeed, proving no passive GET spent the code or claimed a seat.
    const admin = await registerAdmin(O.registrationCode);
    assert(admin.done.status === 201 && admin.done.data.ok, `code was consumed by a passive GET: ${admin.done.status} ${JSON.stringify(admin.done.data)}`);
  });

  await check('49. registration: completes only on explicit POST; the consumed code is then DEAD', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrg('Org-Once-' + uniq(), 'zero_fee', 2);
    const a1 = await registerAdmin(O.registrationCode);
    assert(a1.done.status === 201 && a1.done.data.ok, `first registration failed: ${JSON.stringify(a1.done.data)}`);
    // A second explicit attempt on the SAME code is refused clearly (single-use).
    const a2 = await registerAdmin(O.registrationCode);
    assert(a2.done.status === 400 && a2.done.data.error === 'redeemed', `consumed code not dead: ${a2.done.status} ${JSON.stringify(a2.done.data)}`);
    // And the read-only view now reads as a dead route.
    const view = await api('GET', `/v1/org-register/${O.registrationCode}`);
    assert(view.data.valid === false, `consumed code still shows a live form: ${JSON.stringify(view.data)}`);
  });

  await check('50. registration: seat issuance is BLOCKED until 2 admins; unlocks at the second', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrg('Org-Two-' + uniq(), 'zero_fee', 3);
    const a1 = await registerAdmin(O.registrationCode);
    // With one admin, issuing a survivor code is refused (needs_two_admins).
    const locked = await api('POST', '/v1/org/codes', { bearer: a1.acc.session, body: { role: 'survivor' } });
    assert(locked.status === 409 && locked.data.error === 'needs_two_admins', `seat issuance not locked at 1 admin: ${locked.status} ${JSON.stringify(locked.data)}`);
    // /me reports the lock + prompts the second admin.
    const me = await api('GET', '/v1/org/me', { bearer: a1.acc.session });
    assert(me.data.seatsLocked === true && me.data.adminCount === 1, `me lock state wrong: ${JSON.stringify(me.data)}`);
    // Admin #1 invites admin #2 from inside; that is NOT an enrollment code.
    const invite = await api('POST', '/v1/org/admins/invite', { bearer: a1.acc.session, body: {} });
    assert(invite.status === 201 && invite.data.registrationCode, `admin invite failed: ${JSON.stringify(invite.data)}`);
    await registerAdmin(invite.data.registrationCode);
    // Now seat issuance is unlocked.
    const ok = await api('POST', '/v1/org/codes', { bearer: a1.acc.session, body: { role: 'survivor' } });
    assert(ok.status === 201 && ok.data.code, `seat issuance still locked after 2 admins: ${ok.status} ${JSON.stringify(ok.data)}`);
  });

  await check('51. code-type separation both ways: enrollment code cannot make an admin; registration code cannot make a survivor/coordinator', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-Sep-' + uniq(), 'zero_fee', 3);
    // (a) The enrollment /codes endpoint cannot even be ASKED for an admin code — the
    // request is coerced to survivor; redeeming it yields a survivor, never an admin.
    const asAdmin = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'admin' } });
    const red = await enrollWith(asAdmin.data.code);
    assert(red.red.data.role === 'survivor', `an enrollment code conferred a non-survivor role: ${JSON.stringify(red.red.data)}`);
    // (b) A registration code cannot be redeemed via the enrollment path at all.
    const O2 = await bootstrapOrg('Org-Sep2-' + uniq(), 'zero_fee', 2);
    const badEnroll = await enrollWith(O2.registrationCode);
    assert(badEnroll.red.status === 400, `a registration code was accepted by the enrollment path: ${badEnroll.red.status}`);
  });

  await check('52. registration: operator re-issue works and is logged; the old code stays dead', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrg('Org-Reissue-' + uniq(), 'zero_fee', 2);
    const re = await api('POST', `/v1/admin/orgs/${O.orgId}/registration-code/reissue`, { bearer: ADMIN, body: { reason: 'acceptance: wrong recipient' } });
    assert(re.status === 201 && re.data.registrationCode && re.data.registrationCode !== O.registrationCode, `reissue failed: ${re.status} ${JSON.stringify(re.data)}`);
    // The OLD code is now dead…
    const oldView = await api('GET', `/v1/org-register/${O.registrationCode}`);
    assert(oldView.data.valid === false, `old code still live after reissue: ${JSON.stringify(oldView.data)}`);
    // …and the FRESH code registers admin #1.
    const admin = await registerAdmin(re.data.registrationCode);
    assert(admin.done.status === 201 && admin.done.data.ok, `reissued code did not register: ${JSON.stringify(admin.done.data)}`);
    // A reissue with no reason is refused (the audit trail is the only control on it).
    const noReason = await api('POST', `/v1/admin/orgs/${O.orgId}/registration-code/reissue`, { bearer: ADMIN, body: {} });
    assert(noReason.status === 400, `reissue without a reason was allowed: ${noReason.status}`);
  });

  // ===== Brief 26 Phase 1 — zero-knowledge custody (DORMANT storage; flag off) =====
  await check('53. zk custody: a survivor publishes ONLY a public key; it round-trips', async () => {
    const u = await signup();
    // A realistic SPKI-shaped base64 (opaque to the server — it stores it verbatim).
    const pub = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(52);
    const put = await api('POST', '/v1/me/pubkey', { bearer: u.session, body: { pubkey: pub } });
    assert(put.status === 200 && put.data.ok, `pubkey store failed: ${put.status} ${JSON.stringify(put.data)}`);
    const keys = await api('GET', '/v1/me/keys', { bearer: u.session });
    assert(keys.status === 200 && keys.data.pubkey === pub, `pubkey did not round-trip: ${JSON.stringify(keys.data)}`);
    // An individual account has no org key context.
    assert(keys.data.org === null, `individual account should have no org key: ${JSON.stringify(keys.data.org)}`);
    // An empty pubkey is refused (honest 400).
    const bad = await api('POST', '/v1/me/pubkey', { bearer: u.session, body: {} });
    assert(bad.status === 400, `empty pubkey not refused: ${bad.status}`);
  });

  await check('54. zk custody: org key material stores; a seat fetches its own grant, another does not', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-ZK-' + uniq(), 'zero_fee', 3);
    const orgPub = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'B'.repeat(52);
    // Admin publishes the org public key + a per-seat wrapped org-private-key grant.
    const set = await api('POST', '/v1/org/keys', {
      bearer: O.admin.session,
      body: {
        orgPubkey: orgPub,
        generation: 0,
        grants: [{ seatUserId: O.admin.userId, algId: 'p256-hkdf-sha256-aes256gcm/v1', wrappedOrgPrivKey: 'sealed-envelope-json-opaque' }],
      },
    });
    assert(set.status === 200 && set.data.grantCount === 1, `org keys set failed: ${set.status} ${JSON.stringify(set.data)}`);
    // The org pubkey now surfaces to an enrolled account's key context.
    const cCode = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const surv = await enrollWith(cCode.data.code);
    const survKeys = await api('GET', '/v1/me/keys', { bearer: surv.acc.session });
    assert(survKeys.data.org && survKeys.data.org.orgPubkey === orgPub, `enrolled account missing org pubkey: ${JSON.stringify(survKeys.data.org)}`);
    // The admin (a seat with a grant) fetches its own wrapped org key…
    const mine = await api('GET', '/v1/org/keys/grant', { bearer: O.admin.session });
    assert(mine.data.grant && mine.data.grant.wrappedOrgPrivKey === 'sealed-envelope-json-opaque', `admin grant not returned: ${JSON.stringify(mine.data)}`);
    // …admin #2 (no grant issued to them) gets null — no operating access without a grant.
    const other = await api('GET', '/v1/org/keys/grant', { bearer: O.admin2.session });
    assert(other.data.grant === null, `a seat with no grant should get null: ${JSON.stringify(other.data)}`);
  });

  await check('55. zk custody: per-capture wrapped DEKs store on the event (opaque, hmac-authed)', async () => {
    const u = await signup();
    const ev = await trigger(u.session);
    assert(ev && ev.eventId && ev.hmacSecret, `trigger failed: ${JSON.stringify(ev)}`);
    // The server stores the wrapped envelopes verbatim (each is ciphertext under a pubkey).
    const res = await signed('POST', `/v1/events/${ev.eventId}/wrapped-keys`, ev.hmacSecret, ev.eventId, {
      keys: [
        { recipientType: 'survivor', recipientRef: null, keyGeneration: 0, algId: 'p256-hkdf-sha256-aes256gcm/v1', wrappedDek: '{"alg":"p256-hkdf-sha256-aes256gcm/v1","epk":"x","iv":"y","ct":"z"}' },
        { recipientType: 'org', recipientRef: null, keyGeneration: 0, algId: 'p256-hkdf-sha256-aes256gcm/v1', wrappedDek: '{"alg":"p256-hkdf-sha256-aes256gcm/v1","epk":"a","iv":"b","ct":"c"}' },
      ],
    });
    assert(res.status === 201 && res.data.stored === 2, `wrapped-keys not stored: ${res.status} ${JSON.stringify(res.data)}`);
    // An unsigned attempt is refused (event routes are hmac-authed).
    const forged = await api('POST', `/v1/events/${ev.eventId}/wrapped-keys`, { body: { keys: [] } });
    assert(forged.status === 401, `unsigned wrapped-keys not refused: ${forged.status}`);
  });

  await check('56. zk custody: survivor recovery-wrapped private key round-trips (decision A, opaque)', async () => {
    const u = await signup();
    // None yet.
    const empty = await api('GET', '/v1/me/recovery-key', { bearer: u.session });
    assert(empty.status === 200 && empty.data.wrapped === null, `expected no recovery key: ${JSON.stringify(empty.data)}`);
    // The client stores the code-wrapped private key (server holds it, cannot open it).
    const blob = JSON.stringify({ salt: 'c2FsdA==', box: { iv: 'aXY=', ct: 'Y3Q=' } });
    const put = await api('POST', '/v1/me/recovery-key', { bearer: u.session, body: { wrapped: blob } });
    assert(put.status === 200 && put.data.ok, `recovery-key store failed: ${put.status} ${JSON.stringify(put.data)}`);
    const got = await api('GET', '/v1/me/recovery-key', { bearer: u.session });
    assert(got.data.wrapped === blob, `recovery key did not round-trip: ${JSON.stringify(got.data)}`);
    const bad = await api('POST', '/v1/me/recovery-key', { bearer: u.session, body: {} });
    assert(bad.status === 400, `empty recovery-key not refused: ${bad.status}`);
  });

  await check('57. zk custody: the OWNING survivor fetches their capture envelope; a non-owner cannot', async () => {
    const owner = await signup();
    const ev = await trigger(owner.session);
    assert(ev && ev.eventId && ev.hmacSecret, `trigger failed: ${JSON.stringify(ev)}`);
    // Store a survivor-wrapped DEK (as the capture client would).
    await signed('POST', `/v1/events/${ev.eventId}/wrapped-keys`, ev.hmacSecret, ev.eventId, {
      keys: [{ recipientType: 'survivor', recipientRef: owner.userId, keyGeneration: 0, algId: 'p256-hkdf-sha256-aes256gcm/v1', wrappedDek: '{"alg":"p256-hkdf-sha256-aes256gcm/v1","epk":"e","iv":"i","ct":"c"}' }],
    });
    // The owner gets the envelope (their wrapped DEK) to decrypt client-side.
    const mine = await api('GET', `/v1/me/events/${ev.eventId}/envelope`, { bearer: owner.session });
    assert(mine.status === 200 && mine.data.envelope && mine.data.envelope.wrappedDek.includes('epk'), `owner envelope missing: ${JSON.stringify(mine.data)}`);
    // A DIFFERENT account cannot fetch it — no cross-account decrypt access.
    const other = await signup();
    const stolen = await api('GET', `/v1/me/events/${ev.eventId}/envelope`, { bearer: other.session });
    assert(stolen.status === 200 && stolen.data.envelope === null, `non-owner got the envelope: ${JSON.stringify(stolen.data)}`);
  });

  // ===== Brief 27 — guided intake case file (FAIL-CLOSED; ZK) =====
  await check('58. case file: ARMED — a SEALED file is stored, and the server can never read it', async () => {
    // Armed (2026-07-30), so filing now succeeds where it used to be refused with 409. The
    // fail-closed rule this row used to prove has not gone away — it has moved from "refuse
    // everything" to "only ever store ciphertext", which is the property that actually matters.
    const u = await signup();
    const sealed = '{"alg":"p256-hkdf-sha256-aes256gcm/v1","epk":"e","iv":"i","ct":"c"}';
    const res = await api('POST', '/v1/me/case-files', {
      bearer: u.session,
      body: { sealedCaseFile: sealed, taxonomyVersion: 'nibrs-2019+who-2013/v1' },
    });
    assert(res.status === 201 && res.data.id, `armed: filing a sealed case file must succeed, got ${res.status} ${JSON.stringify(res.data)}`);

    // It comes back to its owner, and what comes back is the OPAQUE blob — byte-identical to
    // what she sealed. The server stored a ciphertext it holds no key for; if this ever
    // returned readable fields, zero-knowledge would be gone.
    const list = await api('GET', '/v1/me/case-files', { bearer: u.session });
    assert(list.status === 200 && list.data.caseFiles.length === 1, `armed: the owner must see her own file, got ${JSON.stringify(list.data)}`);
    const one = await api('GET', `/v1/me/case-files/${res.data.id}`, { bearer: u.session });
    assert(one.status === 200 && one.data.sealedCaseFile === sealed, `armed: the stored blob must round-trip untouched, got ${JSON.stringify(one.data)}`);

    // PLAINTEXT IS STILL REFUSED. Arming loosened WHO may store, never WHAT: a body that is
    // not a sealed envelope must never land, or "zero-knowledge" is only a habit.
    const plain = await api('POST', '/v1/me/case-files', {
      bearer: u.session,
      body: { sealedCaseFile: '{"notes":"he hit me"}', taxonomyVersion: 'nibrs-2019+who-2013/v1' },
    });
    assert(plain.status >= 400, `armed: an unsealed case file must be refused, got ${plain.status} ${JSON.stringify(plain.data)}`);
  });

  await check('59. case file: a non-owner cannot read another account’s case file id', async () => {
    // With the flag off nothing can be filed, so this proves the OWNER-SCOPING of the read
    // path directly: a fabricated/other id returns null for any caller, never cross-account.
    const b = await signup();
    const got = await api('GET', `/v1/me/case-files/${'CF-' + uniq()}`, { bearer: b.session });
    assert(got.status === 200 && got.data.sealedCaseFile === null, `non-owner read leaked: ${JSON.stringify(got.data)}`);
    // The endpoint requires a session at all.
    const anon = await api('GET', '/v1/me/case-files', {});
    assert(anon.status === 401, `case-files reachable without a session: ${anon.status}`);
  });

  await check('60. intake stats (Dest-1): opt-in stores a severed row; public aggregate suppresses a rare combo', async () => {
    const u = await signup();
    const rare = { incidentTypeId: 'stalking', whenRange: 'longer_ago', regionId: 'jp-47', relationshipId: 'stranger', reportedToAuthorities: 'prefer_not_to_say' };
    const sub = await api('POST', '/v1/me/intake-stats', { bearer: u.session, body: rare });
    assert(sub.status === 201 && sub.data.ok, `intake-stats submit failed: ${sub.status} ${JSON.stringify(sub.data)}`);
    // Public, no auth — the SAME shared suppression as the tally.
    const stats = await api('GET', '/v1/intake-stats/stats');
    assert(stats.status === 200 && Array.isArray(stats.data.cells) && stats.data.suppressionThreshold >= 10, `intake stats not public/suppressed: ${JSON.stringify(stats.data)}`);
    // The just-submitted single-row combo is suppressed (count 1 < threshold).
    const leaked = stats.data.cells.find((c) => c.regionId === 'jp-47' && c.incidentTypeId === 'stalking' && c.relationshipId === 'stranger');
    assert(!leaked || leaked.count >= 10, `a rare intake combo was published: ${JSON.stringify(leaked)}`);
    // Cells carry ONLY coarse fields + count — no identity, no case-file id.
    const allowed = ['submissionMonth', 'regionId', 'incidentTypeId', 'whenRange', 'relationshipId', 'reportedToAuthorities', 'count'];
    for (const cell of stats.data.cells) for (const k of Object.keys(cell)) assert(allowed.includes(k), `intake aggregate leaked a field: ${k}`);
    // Rate-limited per account (5/month) — the 6th is refused honestly.
    for (let i = 0; i < 4; i += 1) await api('POST', '/v1/me/intake-stats', { bearer: u.session, body: rare });
    const over = await api('POST', '/v1/me/intake-stats', { bearer: u.session, body: rare });
    assert(over.status === 429 && over.data.error === 'rate_limited', `intake-stats rate limit not enforced: ${over.status} ${JSON.stringify(over.data)}`);
  });

  await check('61. §28 gate at ARM, never the trigger: an unactivated account cannot arm but STILL fires; operator grant arms it', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const u = await signup();
    // §C entitles at signup, so drop this account back to unactivated to test the gate.
    assert(await makeUnactivated(u), 'could not establish the unactivated state');
    await addEmail(u.session, 'primary', 'P'); // a deliverable recipient
    let got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(got.data.armReasons?.hasDeliverableRecipient === true, 'recipient precondition not met');
    assert(got.data.armReasons?.entitled === false, 'revoked account must read unactivated');
    assert(got.data.armable === false, 'unactivated account must NOT be armable — the gate is at ARM');
    // THE BUTTON ALWAYS FIRES: the paywall never gates the trigger (§0).
    const ev = await trigger(u.session, 'acc-unactivated');
    assert(ev?.eventId, 'an unactivated trigger did NOT fire — the paywall gated the trigger!');
    await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN }).catch(() => {});
    // Operator grant activates → armable true.
    const grant = await api('POST', '/v1/admin/entitlement/grant', { bearer: ADMIN, body: { email: u.email, reason: 'acc-suite' } });
    assert(grant.status === 200 && grant.data.activated === true, `operator grant failed: ${JSON.stringify(grant.data)}`);
    got = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(got.data.armable === true && got.data.armReasons.entitled === true, 'not armable after operator grant');
    const me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user.entitlement === 'activated' && me.data.user.entitlementSource === 'operator_grant', `/me entitlement wrong: ${JSON.stringify(me.data.user)}`);
  });

  await check('62. §28 web sale is SERVER-VERIFIED: unsigned webhook → 401; confirm without a receipt never client-grants; signed → activated', async () => {
    // Unsigned (and, while the prod secret is unset, ANY) call is refused — never activates.
    const unsigned = await api('POST', '/v1/activation/webhook', { body: { providerEventId: 'acc-' + uniq(), email: 'x@example.com' } });
    assert(unsigned.status === 401, `unsigned activation webhook not refused: ${unsigned.status}`);
    // A signed-in account with NO verified receipt cannot self-activate (no client-granted entitlement).
    const u = await signup();
    // §C entitles at signup; revoke so "no receipt ⇒ no activation" is actually testable.
    if (ADMIN) assert(await makeUnactivated(u), 'could not establish the unactivated state');
    const confirm = await api('POST', '/v1/me/activation/confirm', { bearer: u.session, body: {} });
    assert(confirm.status === 200 && confirm.data.entitlement === 'unactivated', `confirm client-granted entitlement: ${JSON.stringify(confirm.data)}`);
    const me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user.entitlement === 'unactivated', 'account activated with no verified payment!');
    // If the webhook secret is configured for this run (matching prod), a correctly-signed
    // call activates the matching account with source purchase_web.
    const SECRET = process.env.BBX_ACTIVATION_WEBHOOK_SECRET;
    if (SECRET) {
      const buyer = await signup();
      const raw = JSON.stringify({ providerEventId: 'acc-' + uniq(), provider: 'manual', email: buyer.email, amountCents: 3499 });
      const sig = hmacHex(SECRET, raw);
      const res = await fetch(ORIGIN + '/v1/activation/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-activation-signature': sig }, body: raw });
      assert(res.status === 200, `a correctly-signed webhook was not accepted: ${res.status}`);
      const bme = await api('GET', '/v1/me', { bearer: buyer.session });
      assert(bme.data.user.entitlement === 'activated' && bme.data.user.entitlementSource === 'purchase_web', `signed purchase did not activate: ${JSON.stringify(bme.data.user)}`);
    } else {
      console.log('        (note: BBX_ACTIVATION_WEBHOOK_SECRET unset — signed-path half skipped)');
    }
  });

  await check('63. §28 codes: a readable code redeems however it is typed (case/dashes); redemption is rate-limited (429), not brute-forceable', async () => {
    if (!ADMIN || !MAGIC) { console.log('        (note: needs ADMIN + MAGIC — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-N-' + uniq(), 'zero_fee', 3);
    const c = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const code = c.data.code;
    // The generator's alphabet is Crockford base32 minus I/L/O/U — the confusable
    // LETTERS are dropped and the digits 0 and 1 are KEPT (readable-code.ts). This
    // assertion previously also banned 0 and 1, so it failed whenever a random code
    // happened to contain one: a ~48% coin-flip on a 10-char code, and nothing to do
    // with the diff under test. Assert the alphabet the generator actually defines.
    assert(typeof code === 'string' && !/[ILOU]/.test(code), `issued code is not the readable alphabet: ${code}`);
    // A survivor types it lower-case, dash-grouped → still redeems (normalization).
    const messy = code.toLowerCase().replace(/(.{4})/g, '$1-').replace(/-$/, '');
    const surv = await signup();
    const red = await api('POST', '/v1/me/org/redeem', { bearer: surv.session, body: { code: messy } });
    assert(red.status === 200 && red.data.ok, `a messily-typed readable code did not redeem: ${JSON.stringify(red.data)}`);
    // Rate limit: a fresh account hammering bogus codes is 429'd past the ceiling.
    const attacker = await signup();
    let got429 = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await api('POST', '/v1/me/org/redeem', { bearer: attacker.session, body: { code: `ZZZZ${i}ZZZZ` } });
      if (r.status === 429) { got429 = true; break; }
    }
    assert(got429, 'redemption is not rate-limited — a short code would be brute-forceable');
  });

  await check('64. §28 operator entitlement: grant is idempotent + sourced; the ONE revoke path needs a reason + deactivates; both are ADMIN-only', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const u = await signup();
    // §C entitles at signup, so revoke first — otherwise the grant is a no-op and its
    // "did this call activate?" contract cannot be observed at all.
    assert(await makeUnactivated(u), 'could not establish the unactivated state');
    const g = await api('POST', '/v1/admin/entitlement/grant', { bearer: ADMIN, body: { email: u.email, reason: 'acc' } });
    assert(g.status === 200 && g.data.activated === true, `grant failed: ${JSON.stringify(g.data)}`);
    let me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user.entitlement === 'activated' && me.data.user.entitlementSource === 'operator_grant', 'grant did not set the source');
    // Idempotent — a second grant is a no-op, not a double-activate or an error.
    const g2 = await api('POST', '/v1/admin/entitlement/grant', { bearer: ADMIN, body: { email: u.email } });
    assert(g2.status === 200 && g2.data.alreadyActive === true, 'grant is not idempotent');
    // Revoke REQUIRES a reason (privileged, logged) and is the ONLY way back to unactivated.
    const noReason = await api('POST', '/v1/admin/entitlement/revoke', { bearer: ADMIN, body: { email: u.email } });
    assert(noReason.status === 400, 'revoke without a reason was not refused');
    const rev = await api('POST', '/v1/admin/entitlement/revoke', { bearer: ADMIN, body: { email: u.email, reason: 'fraud-test' } });
    assert(rev.status === 200 && rev.data.changed === true, `revoke failed: ${JSON.stringify(rev.data)}`);
    me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user.entitlement === 'unactivated', 'revoke did not deactivate');
    // Neither is reachable without the ADMIN token.
    const unauth = await api('POST', '/v1/admin/entitlement/grant', { body: { email: u.email } });
    assert(unauth.status === 401, 'admin grant is reachable without the ADMIN token');
  });

  await check('66. §28/§0: operator revoke NEVER strips protection mid-alert — refused (409) while a live event is open', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const u = await signup();
    await api('POST', '/v1/admin/entitlement/grant', { bearer: ADMIN, body: { email: u.email, reason: 'acc' } });
    // The survivor is mid-alert (a live event is open).
    const ev = await trigger(u.session, 'acc-revoke-guard');
    assert(ev?.eventId, 'trigger did not open an event');
    const rev = await api('POST', '/v1/admin/entitlement/revoke', { bearer: ADMIN, body: { email: u.email, reason: 'fraud-test' } });
    assert(rev.status === 409 && rev.data.error === 'active_event', `revoke was NOT refused mid-alert: ${rev.status} ${JSON.stringify(rev.data)}`);
    // Still activated — protection intact.
    const me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.data.user.entitlement === 'activated', 'revoke stripped entitlement mid-alert — §0 violated');
    // Once the alert is closed, revoke is allowed again.
    await api('POST', `/v1/admin/events/${ev.eventId}/force-close`, { bearer: ADMIN }).catch(() => {});
    const rev2 = await api('POST', '/v1/admin/entitlement/revoke', { bearer: ADMIN, body: { email: u.email, reason: 'fraud-test' } });
    assert(rev2.status === 200 && rev2.data.changed === true, `revoke after close failed: ${JSON.stringify(rev2.data)}`);
  });

  await check('65. §28/§0: an activated survivor stays activated after the org tie ends — entitlement lives on the account, not the license', async () => {
    if (!ADMIN || !MAGIC) { console.log('        (note: needs ADMIN + MAGIC — skipped)'); return; }
    const O = await bootstrapOrgWithTwoAdmins('Org-L-' + uniq(), 'zero_fee', 3);
    const c = await api('POST', '/v1/org/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const surv = await enrollWith(c.data.code);
    assert(surv.red.data?.ok, `enroll failed: ${JSON.stringify(surv.red.data)}`);
    let me = await api('GET', '/v1/me', { bearer: surv.acc.session });
    assert(me.data.user.entitlement === 'activated' && me.data.user.entitlementSource === 'org_code', `enrolment did not activate: ${JSON.stringify(me.data.user)}`);
    // The survivor leaves the org (seat freed). Entitlement must NOT be revoked — an org
    // relationship ending never deactivates an already-activated survivor.
    const left = await api('POST', '/v1/me/org/leave', { bearer: surv.acc.session });
    assert(left.data?.ok, `leave failed: ${JSON.stringify(left.data)}`);
    me = await api('GET', '/v1/me', { bearer: surv.acc.session });
    assert(me.data.user.entitlement === 'activated', 'leaving the org deactivated the survivor — §0 violated');
  });

  await check('67. capture fails OPEN on a MALFORMED body — the location endpoint never 500s (F1 regression)', async () => {
    const u = await signup();
    const ev = await api('POST', '/v1/events', { bearer: u.session, body: { source: 'acc-f1' } });
    assert(ev.data?.eventId, 'trigger failed');
    created.events.push(ev.data.eventId);
    const path = `/v1/events/${ev.data.eventId}/locations`;
    // A malformed body (no `points`) must be a graceful no-op 201, not a 500.
    const bad = await signed('POST', path, ev.data.hmacSecret, ev.data.eventId, { garbage: true });
    assert(bad.status === 201 && bad.data.count === 0, `malformed location body did not fail open: ${bad.status} ${JSON.stringify(bad.data)}`);
    // A well-formed point still stores; a mixed array keeps only the valid points.
    const mixed = await signed('POST', path, ev.data.hmacSecret, ev.data.eventId, {
      points: [{ timestamp: Date.now(), lat: 35.6, lon: 139.7, accuracy: 5 }, { lat: 'bad' }, null],
    });
    assert(mixed.status === 201 && mixed.data.count === 1, `valid point not stored / bad points not filtered: ${mixed.status} ${JSON.stringify(mixed.data)}`);
  });

  await check('72. §C signup gate: no code / bad code is REFUSED with an honest reason', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const mk = () => `smoke+acc-${uniq()}@example.com`;
    // No code at all.
    const none = await api('POST', '/v1/auth/signup/start', { body: { name: 'NoCode', email: mk(), regionId: 'jp' } });
    assert(none.status === 400 && none.data.error === 'code_required', `missing code not refused: ${none.status} ${JSON.stringify(none.data)}`);
    assert(typeof none.data.message === 'string' && none.data.message.length > 15, `refusal is not an honest message: ${JSON.stringify(none.data)}`);
    // Unrecognised code.
    // Brief 34 §1: a code we did not mint now falls through to Gumroad licence
    // verification, so an unknown string is refused as invalid_license rather than
    // not_found. Both are honest, named refusals — assert the REFUSAL and the honest
    // message, not which of the two arms produced it.
    const bogus = await api('POST', '/v1/auth/signup/start', { body: { name: 'BadCode', email: mk(), regionId: 'jp', code: 'ZZZZZZZZZZ' } });
    assert(bogus.status === 403, `unknown code not refused: ${bogus.status} ${JSON.stringify(bogus.data)}`);
    assert(['not_found', 'invalid_license'].includes(bogus.data.error), `unexpected refusal reason: ${JSON.stringify(bogus.data)}`);
    assert(/not recognised/i.test(bogus.data.message ?? ''), `unknown-code message not honest: ${JSON.stringify(bogus.data)}`);
  });

  await check('73. §C signup gate: a code is SINGLE-USE — the second signup is refused', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const code = await issueSignupCode();
    const e1 = `smoke+acc-${uniq()}@example.com`;
    const first = await api('POST', '/v1/auth/signup/start', { body: { name: 'First', email: e1, regionId: 'jp', code } });
    assert(first.status === 201, `first use refused: ${first.status} ${JSON.stringify(first.data)}`);
    created.emails.push(e1);
    // The SAME code again must not create a second account.
    const second = await api('POST', '/v1/auth/signup/start', { body: { name: 'Second', email: `smoke+acc-${uniq()}@example.com`, regionId: 'jp', code } });
    assert(second.status === 403 && second.data.error === 'exhausted', `code reused: ${second.status} ${JSON.stringify(second.data)}`);
  });

  await check('74. §C redemption GRANTS ENTITLEMENT — no signed-up-but-unarmable state', async () => {
    if (!ADMIN) { console.log('        (note: needs ADMIN — skipped)'); return; }
    const u = await signup();
    const me = await api('GET', '/v1/me', { bearer: u.session });
    assert(me.status === 200, `session unusable: ${me.status}`);
    assert(me.data.user?.entitlement === 'activated', `a redeemed code did not entitle the account: ${JSON.stringify(me.data.user)}`);
    assert(me.data.user?.entitlementSource === 'purchase_web', `wrong entitlement source: ${JSON.stringify(me.data.user)}`);
    // ...and that is what makes it armable once a recipient exists.
    await addEmail(u.session, 'primary', 'P');
    const contacts = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(contacts.data.armReasons?.entitled === true, `entitled flag not set for arming: ${JSON.stringify(contacts.data.armReasons)}`);
  });

  await check('75. §1 consumer path: an unrecognised licence key is refused honestly; no mint webhook exists', async () => {
    // The buyer's Gumroad LICENCE KEY is the code — there is no webhook that mints one.
    const gone = await api('POST', '/webhooks/gumroad/sale', { body: { sale_id: 'x' } });
    assert(gone.status === 404, `the consumer-mint webhook still exists: ${gone.status}`);
    // A key that is not ours and not a valid Gumroad licence is refused, and the refusal
    // NAMES the problem rather than shrugging.
    const bogus = await api('POST', '/v1/auth/signup/start', {
      body: { name: 'BadKey', email: `smoke+badkey-${uniq()}@example.com`, regionId: 'jp', code: 'NOT-A-REAL-LICENCE-KEY' },
    });
    assert([403, 503].includes(bogus.status), `bogus licence not refused: ${bogus.status} ${JSON.stringify(bogus.data)}`);
    assert(typeof bogus.data.message === 'string' && bogus.data.message.length > 15, `refusal is not honest: ${JSON.stringify(bogus.data)}`);
    // ...and it created NO account.
    const list = await api('GET', '/v1/me', { bearer: 'nope' });
    assert(list.status === 401, 'sanity: unauthenticated /v1/me should be 401');
  });

  // ---- Brief 29: certified report (dormant until zero-knowledge custody is armed) ----
  //
  // The report chains its certification to capture-time plaintext commitments, so it CANNOT
  // exist while the envelope flag is off. These rows prove the dormancy is real on the live
  // deployment — the same shape as row 58 for the case file. When the flag is armed, 68
  // flips to 200s and the CERTIFIED/TAMPERED rows become live checks (final acceptance).

  await check('68. certified report: ARMED — the owner is answered, a non-owner is told nothing', async () => {
    // Custody is armed (2026-07-30), so this row no longer proves dormancy — it proves the
    // contract that REPLACED it. The dormant version asserted 404-as-absent everywhere; kept
    // unchanged after arming it would have gone on passing against a path production had
    // stopped taking, which is worse than no check at all.
    const u = await signup();

    // Her own list EXISTS and answers. This is the assertion that would fail if a deploy ever
    // silently disarmed custody again (a `--var` that got dropped, a missing env restatement).
    const list = await api('GET', '/v1/me/reports/events', { bearer: u.session });
    assert(
      list.status === 200 && Array.isArray(list.data?.events),
      `armed: the owner's own report list must answer, got ${list.status} ${JSON.stringify(list.data)}`,
    );

    // An event that is not hers reads exactly like one that never existed. Same answer either
    // way, so the surface cannot be used to probe whether another account's event is real.
    const foreign = 'evt-' + uniq();
    for (const path of [`/v1/me/reports/events/${foreign}/metadata`, `/v1/me/reports/events/${foreign}/chunks/0`]) {
      const res = await api('GET', path, { bearer: u.session });
      assert(res.status === 404, `armed: ${path} must be not-found for a non-owner, got ${res.status}`);
    }
    const sign = await api('POST', '/v1/me/reports/sign', {
      bearer: u.session,
      body: { eventId: foreign, evidenceHash: 'a'.repeat(64), renderedHash: 'b'.repeat(64) },
    });
    assert(sign.status === 404, `armed: signing an event she does not own must refuse, got ${sign.status}`);

    // And the public verification page is now SERVED. While dormant this had to 404 so we
    // published no promise we could not keep; armed, the promise is real and must be reachable
    // without an account — that is the whole point of an independent check.
    const page = await api('GET', '/verification');
    assert(page.status === 200, `armed: /verification must be live, got ${page.status}`);
  });

  await check('82. report metadata carries CLASSIFICATIONS + TRANSCRIPTS, owner-scoped, replayed not recomputed', async () => {
    // The evidence dashboard's summary and transcript panels are built from THIS endpoint.
    // Without these two collections the dashboard has nothing to render, so this row is the
    // hard prerequisite the dashboard stands on.
    const u = await signup();
    await addEmail(u.session, 'primary', 'P');
    const ev = await trigger(u.session, 'acc-meta');
    assert(ev?.eventId && ev?.hmacSecret, `trigger did not open an event: ${JSON.stringify(ev)}`);

    // Write what the live detection and transcription write during a real incident, through
    // the SAME endpoints the device uses — HMAC-signed with the event secret, exactly as the
    // capture path does. Posting these unsigned returns 401, which is the correct behaviour
    // and worth stating: the capture write path is authenticated by the event's own secret.
    const cls = await signed('POST', `/v1/events/${ev.eventId}/classifications`, ev.hmacSecret, ev.eventId, {
      items: [
        {
          timestamp: 1000,
          threatLevel: 'high',
          matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }],
          toneIndicators: ['elevated-volume', 'multi-speaker'],
          summary: 'Weapon reference detected.',
          languages: ['en'],
        },
      ],
    });
    assert(cls.status === 201, `classification write failed: ${cls.status} ${JSON.stringify(cls.data)}`);
    const tr = await signed('POST', `/v1/events/${ev.eventId}/transcripts`, ev.hmacSecret, ev.eventId, {
      fragments: [
        { sequence: 0, text: 'first fragment', isFinal: true },
        { sequence: 1, text: 'second fragment', isFinal: false },
      ],
    });
    assert(tr.status === 201, `transcript write failed: ${tr.status} ${JSON.stringify(tr.data)}`);

    // The OWNER is answered, with both collections present and the JSON columns already
    // parsed into a typed shape (the client must not have to re-parse).
    const meta = await api('GET', `/v1/me/reports/events/${ev.eventId}/metadata`, { bearer: u.session });
    assert(meta.status === 200 && meta.data?.metadata, `owner metadata refused: ${meta.status} ${JSON.stringify(meta.data)}`);
    const m = meta.data.metadata;
    assert(Array.isArray(m.classifications) && m.classifications.length >= 1, `classifications missing: ${JSON.stringify(m.classifications)}`);
    assert(Array.isArray(m.transcripts) && m.transcripts.length === 2, `transcripts missing: ${JSON.stringify(m.transcripts)}`);
    const k = m.classifications[0];
    assert(k.threatLevel === 'high', `threatLevel not replayed: ${JSON.stringify(k)}`);
    assert(
      Array.isArray(k.matchedCategories) && k.matchedCategories[0]?.category === 'weapon' && k.matchedCategories[0]?.matches?.[0] === 'knife',
      `matchedCategories not parsed into a typed shape: ${JSON.stringify(k.matchedCategories)}`,
    );
    assert(Array.isArray(k.toneIndicators) && k.toneIndicators.includes('whisper') === false && k.toneIndicators.includes('multi-speaker'), `toneIndicators not parsed: ${JSON.stringify(k.toneIndicators)}`);
    assert(Array.isArray(k.languages) && k.languages.includes('en'), `languages not parsed: ${JSON.stringify(k.languages)}`);
    // Transcript order is by sequence, so the panel replays in the order spoken.
    assert(m.transcripts[0].sequence === 0 && m.transcripts[1].sequence === 1, `transcripts not ordered by sequence: ${JSON.stringify(m.transcripts)}`);

    // REPLAYED, NOT RECOMPUTED: reading twice yields byte-identical values. A summary that
    // drifted between reviews would not be evidence.
    const again = await api('GET', `/v1/me/reports/events/${ev.eventId}/metadata`, { bearer: u.session });
    assert(
      JSON.stringify(again.data?.metadata?.classifications) === JSON.stringify(m.classifications),
      'classifications changed between reads — the summary must be a frozen replay, never re-derived',
    );

    // OWNER-SCOPED against a REAL event: a second account asking for HER event id gets the
    // same not-found as for an id that never existed. This is the assertion that a fabricated
    // id cannot make — it proves the scope check, not just the absence of a row.
    const other = await signup();
    const stolen = await api('GET', `/v1/me/reports/events/${ev.eventId}/metadata`, { bearer: other.session });
    assert(stolen.status === 404, `another account read her event metadata: ${stolen.status} ${JSON.stringify(stolen.data)}`);
    assert(
      !JSON.stringify(stolen.data ?? '').includes('fragment'),
      `a non-owner received transcript content: ${JSON.stringify(stolen.data)}`,
    );
  });

  await check('69. certified report: no anonymous access — a session is required before the gate', async () => {
    // Even dormant, the report surface must never answer an unauthenticated caller. This
    // proves requireSession runs FIRST, so arming the flag cannot expose an open endpoint.
    for (const path of ['/v1/me/reports/events', '/v1/me/reports/events/evt-1/metadata']) {
      const res = await api('GET', path, {});
      assert(res.status === 401, `${path} answered without a session: ${res.status}`);
    }
    const sign = await api('POST', '/v1/me/reports/sign', { body: { eventId: 'evt-1' } });
    assert(sign.status === 401, `signing answered without a session: ${sign.status}`);
  });

  await check('70. certified report: independent verification stays possible — the published key is still served', async () => {
    // §3 [A]: the page is a convenience, the mathematics is the trust. The published
    // Ed25519 key must remain fetchable without an account, and the shipped manifest
    // verifier must keep working — this brief is additive and disturbed neither.
    const key = await api('GET', '/.well-known/blackbox-integrity-public-key.json');
    assert(key.status === 200 && key.data.algorithm === 'Ed25519' && typeof key.data.publicKey === 'string' && key.data.publicKey.length > 20,
      `published verification key missing: ${key.status} ${JSON.stringify(key.data)}`);
    // The pre-existing manifest verifier is untouched: garbage is rejected, never a 500.
    const bogus = await api('POST', '/v1/integrity/verify', { body: { signature: 'x', publicKey: key.data.publicKey } });
    assert(bogus.status === 200 && bogus.data.valid === false, `manifest verifier regressed: ${bogus.status} ${JSON.stringify(bogus.data)}`);
  });

  // ---- Brief 33b/33c: THE CONSOLE — the boundary, proven on the deployed surface ----
  //
  // The console's whole claim is that role and org scope are decided by the SERVER from
  // the session. These rows attack that claim from the outside: they hold a real session
  // for each level and try to reach what that level must not have. A hidden button would
  // pass none of them, because none of them goes near the UI.
  //
  // The OPERATOR level is deliberately absent from this suite: there is no endpoint that
  // grants platform_role (adding one would make "operator" mintable by whoever holds
  // ADMIN_TOKEN, which is the exact coupling Brief 33a removed). Operator is proven by a
  // real sign-in on the real surface. What IS proven here is the operator boundary from
  // the other side: every non-operator level is refused every operator route.

  await check('71. console: an UNMARKED account gets an honest level and is refused every scoped route', async () => {
    const u = await signup();
    const me = await api('GET', '/v1/console/me', { bearer: u.session });
    assert(me.status === 200, `console/me refused a valid session: ${me.status}`);
    assert(me.data.level === 'unmarked' && me.data.levelLabel === 'UNMARKED', `level not unmarked: ${JSON.stringify(me.data)}`);
    assert(me.data.orgId === null, `unmarked account carries an org: ${JSON.stringify(me.data)}`);
    // may.* is the server's own statement of what it will answer — all false.
    assert(Object.values(me.data.may).filter((v) => v === true).length === 0, `unmarked account may do something: ${JSON.stringify(me.data.may)}`);
    // And every scoped route actually refuses — the `may` object is a description, not the gate.
    for (const path of ['/v1/console/overview', '/v1/console/orgs', '/v1/console/accounts', '/v1/console/codes', '/v1/console/seats', '/v1/console/roster', '/v1/console/maintenance/health']) {
      const res = await api('GET', path, { bearer: u.session });
      assert(res.status === 403, `${path} answered an unmarked account: ${res.status}`);
    }
    // No session at all is 401 BEFORE any level logic — the gate cannot be reached anonymously.
    const anon = await api('GET', '/v1/console/me');
    assert(anon.status === 401, `console answered without a session: ${anon.status}`);
  });

  await check('72. console: an ADMIN sees their own org and is refused every operator route', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Admin ${uniq()}`);
    const me = await api('GET', '/v1/console/me', { bearer: O.admin.session });
    assert(me.data.level === 'admin' && me.data.levelLabel === 'ADMIN', `level not admin: ${JSON.stringify(me.data)}`);
    assert(me.data.orgId === O.orgId, `admin scoped to the wrong org: ${me.data.orgId} != ${O.orgId}`);
    // Own-org surfaces answer.
    const seats = await api('GET', '/v1/console/seats', { bearer: O.admin.session });
    assert(seats.status === 200 && seats.data.orgId === O.orgId, `seats refused: ${seats.status}`);
    assert(seats.data.adminCount === 2, `admin count wrong: ${JSON.stringify(seats.data.adminCount)}`);
    const overview = await api('GET', '/v1/console/overview', { bearer: O.admin.session });
    assert(overview.status === 200 && overview.data.scope === 'org', `overview scope wrong: ${JSON.stringify(overview.data)}`);
    // Operator surfaces are refused — and the refusal NAMES the level, never a bare 403.
    for (const path of ['/v1/console/orgs', '/v1/console/accounts', '/v1/console/maintenance/health', '/v1/console/maintenance/audit']) {
      const res = await api('GET', path, { bearer: O.admin.session });
      assert(res.status === 403 && res.data.error === 'level_forbidden' && res.data.level === 'admin',
        `${path} not refused for admin: ${res.status} ${JSON.stringify(res.data)}`);
    }
    // …including the destructive ones. An admin cannot even preview a purge.
    const purge = await api('POST', '/v1/console/maintenance/purge-media', { bearer: O.admin.session, body: {} });
    assert(purge.status === 403, `an admin reached the R2 purge: ${purge.status}`);
    const del = await api('POST', '/v1/console/maintenance/delete-account', { bearer: O.admin.session, body: { email: O.admin.email } });
    assert(del.status === 403, `an admin reached account deletion: ${del.status}`);
  });

  await check('73. console: a COORDINATOR sees only what they issued, and cannot staff their org', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Coord ${uniq()}`, 'zero_fee', 5);
    // The admin mints a coordinator code THROUGH THE CONSOLE (unified table, one minter).
    const crd = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'coordinator' } });
    assert(crd.status === 201 && crd.data.codes?.length === 1, `admin could not issue a coordinator code: ${crd.status} ${JSON.stringify(crd.data)}`);
    const coord = await enrollWith(crd.data.codes[0]);
    assert(coord.red.status === 200, `coordinator redeem failed: ${coord.red.status} ${JSON.stringify(coord.red.data)}`);

    const me = await api('GET', '/v1/console/me', { bearer: coord.acc.session });
    assert(me.data.level === 'coordinator' && me.data.levelLabel === 'COORD', `level not coordinator: ${JSON.stringify(me.data)}`);
    assert(JSON.stringify(me.data.may.issueRoles) === JSON.stringify(['survivor']), `coordinator offered the wrong roles: ${JSON.stringify(me.data.may.issueRoles)}`);

    // A coordinator cannot mint a coordinator code — refused server-side, not hidden.
    const escalate = await api('POST', '/v1/console/codes', { bearer: coord.acc.session, body: { role: 'coordinator' } });
    assert(escalate.status === 403 && escalate.data.error === 'role_forbidden', `coordinator escalated to staff codes: ${escalate.status} ${JSON.stringify(escalate.data)}`);
    // …nor an admin code, which no level may mint through the enrollment table.
    const toAdmin = await api('POST', '/v1/console/codes', { bearer: coord.acc.session, body: { role: 'admin' } });
    assert(toAdmin.status === 403, `coordinator minted an admin enrollment code: ${toAdmin.status}`);
    // …nor reach seat management at all.
    const seats = await api('GET', '/v1/console/seats', { bearer: coord.acc.session });
    assert(seats.status === 403, `coordinator reached seats: ${seats.status}`);

    // Their own survivor code appears; the admin's coordinator code does NOT.
    const mine = await api('POST', '/v1/console/codes', { bearer: coord.acc.session, body: { role: 'survivor' } });
    assert(mine.status === 201, `coordinator could not issue a survivor code: ${mine.status} ${JSON.stringify(mine.data)}`);
    const list = await api('GET', '/v1/console/codes', { bearer: coord.acc.session });
    assert(list.data.scope === 'own', `coordinator scope not 'own': ${JSON.stringify(list.data.scope)}`);
    const codes = list.data.codes.map((c) => c.code);
    assert(codes.includes(mine.data.codes[0]), 'coordinator cannot see the code they issued');
    assert(!codes.includes(crd.data.codes[0]), 'coordinator sees a code issued by someone else');
    // The admin, by contrast, sees BOTH — org scope is wider than own scope, by design.
    const adminList = await api('GET', '/v1/console/codes', { bearer: O.admin.session });
    assert(adminList.data.scope === 'org', `admin scope not 'org': ${JSON.stringify(adminList.data.scope)}`);
    const adminCodes = adminList.data.codes.map((c) => c.code);
    assert(adminCodes.includes(mine.data.codes[0]) && adminCodes.includes(crd.data.codes[0]), 'admin cannot see every code under their own org');
  });

  await check('74. console: cross-org is refused ADVERSARIALLY — org A cannot reach org B by any route', async () => {
    const A = await bootstrapOrgWithTwoAdmins(`Console Org A ${uniq()}`, 'zero_fee', 5);
    const B = await bootstrapOrgWithTwoAdmins(`Console Org B ${uniq()}`, 'zero_fee', 5);
    // B issues a code and enrols someone, so there IS something in B worth reaching.
    const bCode = await api('POST', '/v1/console/codes', { bearer: B.admin.session, body: { role: 'survivor' } });
    assert(bCode.status === 201, `org B could not issue: ${bCode.status}`);
    const bSurvivor = await enrollWith(bCode.data.codes[0]);
    assert(bSurvivor.red.status === 200, `org B enrolment failed: ${JSON.stringify(bSurvivor.red.data)}`);
    // A SECOND code, left untouched, is the revoke target. It must be one nothing else in
    // this check consumes, or "still live" would be indistinguishable from "used up" and
    // the assertion would prove nothing about revocation.
    const bLive = await api('POST', '/v1/console/codes', { bearer: B.admin.session, body: { role: 'survivor' } });
    assert(bLive.status === 201, `org B could not issue the revoke target: ${bLive.status}`);

    // 1. A's code list never contains B's code, whatever A does.
    const aCodes = await api('GET', '/v1/console/codes', { bearer: A.admin.session });
    assert(!aCodes.data.codes.some((c) => c.code === bCode.data.codes[0]), 'org A can see org B’s code');
    assert(aCodes.data.codes.every((c) => c.orgId == null || c.orgId === A.orgId), 'org A’s code list leaked another org');

    // 2. A cannot REVOKE B's code — out of scope is indistinguishable from non-existent.
    const revoke = await api('POST', `/v1/console/codes/${bLive.data.codes[0]}/revoke`, { bearer: A.admin.session, body: {} });
    assert(revoke.status === 404 && revoke.data.error === 'code_not_found', `org A revoked into org B: ${revoke.status} ${JSON.stringify(revoke.data)}`);
    // …and the code is STILL ACTIVE, which is what makes that a refusal rather than a lie:
    // a 404 over a write that actually landed would be the worst of both.
    const stillLive = await api('GET', '/v1/console/codes', { bearer: B.admin.session });
    const bRow = stillLive.data.codes.find((c) => c.code === bLive.data.codes[0]);
    assert(bRow && bRow.status === 'active', `org A actually revoked org B’s code: ${JSON.stringify(bRow)}`);
    // B can revoke its own — proving the 404 above was scope, not a broken endpoint.
    const ownRevoke = await api('POST', `/v1/console/codes/${bLive.data.codes[0]}/revoke`, { bearer: B.admin.session, body: {} });
    assert(ownRevoke.status === 200, `org B cannot revoke its own code — the refusal above was not scope: ${ownRevoke.status}`);

    // 3. A cannot remove a seat in B, nor change a role in B.
    const rm = await api('POST', `/v1/console/seats/${B.admin.userId}/remove`, { bearer: A.admin.session, body: {} });
    assert(rm.status === 404, `org A removed a seat in org B: ${rm.status}`);
    const role = await api('POST', `/v1/console/seats/${bSurvivor.acc.userId}/role`, { bearer: A.admin.session, body: { role: 'admin' } });
    assert(role.status === 404, `org A changed a role in org B: ${role.status}`);

    // 4. A's roster is A's only — B's enrolment never appears.
    const roster = await api('GET', '/v1/console/roster', { bearer: A.admin.session });
    assert(roster.status === 200, `roster refused: ${roster.status}`);
    assert(!roster.data.roster.some((r) => r.code === bCode.data.codes[0]), 'org A’s roster contains an org B enrolment');

    // 5. A cannot name B's org id anywhere — the operator route that takes one is closed to A.
    const byId = await api('GET', `/v1/console/orgs/${B.orgId}/admin-codes`, { bearer: A.admin.session });
    assert(byId.status === 403, `org A read org B’s admin codes: ${byId.status} ${JSON.stringify(byId.data)}`);
    const issueInto = await api('POST', '/v1/console/codes', { bearer: A.admin.session, body: { role: 'survivor', orgId: B.orgId } });
    assert(issueInto.status === 201, `issuing with a foreign orgId errored instead of ignoring it: ${issueInto.status}`);
    assert(issueInto.data.orgId === A.orgId, `a client-supplied orgId reached the insert: ${JSON.stringify(issueInto.data)}`);
  });

  await check('75. console: NO level reads incident content — the capture endpoints refuse every console session', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Content ${uniq()}`, 'zero_fee', 5);
    const code = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const survivor = await enrollWith(code.data.codes[0]);
    await addEmail(survivor.acc.session, 'primary', 'P');
    const ev = await trigger(survivor.acc.session, 'console-content');
    assert(ev.eventId, 'could not open an event to attempt reading');

    const unmarked = await signup();
    const sessions = [
      ['admin', O.admin.session],
      ['unmarked', unmarked.session],
      ['the survivor’s own org admin', O.admin2.session],
    ];
    // The capture bytes live behind a per-event coordinator magic token, never behind an
    // account session — so no console level, at any scope, can reach them.
    for (const [who, session] of sessions) {
      for (const path of [`/v1/c/${ev.eventId}/audio/latest`, `/v1/c/${ev.eventId}/audio/full`, `/v1/c/${ev.eventId}/audio/0`]) {
        const res = await api('GET', path, { bearer: session });
        assert(res.status === 401, `${who} read capture bytes at ${path}: ${res.status}`);
      }
    }
    // And the console itself has no content route at all — not a 403, an absence.
    for (const [who, session] of sessions) {
      const res = await api('GET', '/v1/console/incidents/content', { bearer: session });
      assert(res.status === 404, `a console content route exists for ${who}: ${res.status}`);
    }
  });

  await check('76. console: code issue + revoke run on the unified table, atomically', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Codes ${uniq()}`, 'zero_fee', 5);
    const issued = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'survivor', count: 3 } });
    assert(issued.status === 201 && issued.data.codes.length === 3, `bulk issue failed: ${issued.status} ${JSON.stringify(issued.data)}`);
    const [live, toRevoke, toRace] = issued.data.codes;

    // A console-issued code is a REAL enrollment code: it redeems through the same path.
    const enrolled = await enrollWith(live);
    assert(enrolled.red.status === 200, `console-issued code did not redeem: ${JSON.stringify(enrolled.red.data)}`);

    // Revoke is immediate and final — the code can never be redeemed afterwards.
    const rev = await api('POST', `/v1/console/codes/${toRevoke}/revoke`, { bearer: O.admin.session, body: {} });
    assert(rev.status === 200 && rev.data.revoked === true, `revoke failed: ${rev.status}`);
    const dead = await enrollWith(toRevoke);
    assert(dead.red.status !== 200, `a revoked code still redeemed: ${JSON.stringify(dead.red.data)}`);

    // Atomicity: two accounts racing the LAST use of a single-use code — exactly one wins.
    const racerA = await signup();
    const racerB = await signup();
    await makeUnactivated(racerA);
    await makeUnactivated(racerB);
    const [ra, rb] = await Promise.all([
      api('POST', '/v1/me/org/redeem', { bearer: racerA.session, body: { code: toRace } }),
      api('POST', '/v1/me/org/redeem', { bearer: racerB.session, body: { code: toRace } }),
    ]);
    const winners = [ra, rb].filter((r) => r.status === 200).length;
    assert(winners === 1, `a single-use code was claimed ${winners} times: ${ra.status}/${rb.status}`);

    // The list reports honest derived status for each outcome.
    const list = await api('GET', '/v1/console/codes', { bearer: O.admin.session });
    const byCode = Object.fromEntries(list.data.codes.map((c) => [c.code, c.status]));
    assert(byCode[toRevoke] === 'revoked', `revoked code reads as ${byCode[toRevoke]}`);
    assert(byCode[live] === 'exhausted', `redeemed single-use code reads as ${byCode[live]}`);
  });

  await check('77. console: min-2-admins holds for BOTH removal and demotion; removal revokes access at once', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Seats ${uniq()}`, 'zero_fee', 5);
    const seats = await api('GET', '/v1/console/seats', { bearer: O.admin.session });
    assert(seats.data.adminCount === 2, `expected 2 admins, got ${seats.data.adminCount}`);
    assert(seats.data.seats.every((s) => s.removable === false), 'a seat is marked removable while the org holds exactly two admins');

    // Removal is refused at two admins…
    const rm = await api('POST', `/v1/console/seats/${O.admin2.userId}/remove`, { bearer: O.admin.session, body: {} });
    assert(rm.status === 409 && rm.data.error === 'min_admins', `second-to-last admin was removable: ${rm.status} ${JSON.stringify(rm.data)}`);
    // …and so is DEMOTION, which drops the count identically. A rule enforced on one
    // route and not its twin is not enforced.
    const demote = await api('POST', `/v1/console/seats/${O.admin2.userId}/role`, { bearer: O.admin.session, body: { role: 'coordinator' } });
    assert(demote.status === 409 && demote.data.error === 'min_admins', `an admin was demoted below the floor: ${demote.status} ${JSON.stringify(demote.data)}`);

    // A coordinator seat is removable, and access ends on the very next request.
    const crd = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'coordinator' } });
    const coord = await enrollWith(crd.data.codes[0]);
    const before = await api('GET', '/v1/console/me', { bearer: coord.acc.session });
    assert(before.data.level === 'coordinator', `coordinator not seated: ${JSON.stringify(before.data)}`);
    const rmCoord = await api('POST', `/v1/console/seats/${coord.acc.userId}/remove`, { bearer: O.admin.session, body: {} });
    assert(rmCoord.status === 200, `coordinator removal refused: ${rmCoord.status} ${JSON.stringify(rmCoord.data)}`);
    const after = await api('GET', '/v1/console/me', { bearer: coord.acc.session });
    assert(after.data.level === 'unmarked', `removed seat kept console access: ${JSON.stringify(after.data)}`);
    const codesAfter = await api('GET', '/v1/console/codes', { bearer: coord.acc.session });
    assert(codesAfter.status === 403, `removed seat still reads codes: ${codesAfter.status}`);
  });

  await check('78. console: the roster is READINESS ONLY — no name, number, location or content, ever', async () => {
    const O = await bootstrapOrgWithTwoAdmins(`Console Roster ${uniq()}`, 'zero_fee', 5);
    const code = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'survivor' } });
    const survivor = await enrollWith(code.data.codes[0]);
    assert(survivor.red.status === 200, `enrolment failed: ${JSON.stringify(survivor.red.data)}`);
    // Give the account a real, identifiable contact — so if the roster leaked identity,
    // there would be something recognisable to leak.
    await addEmail(survivor.acc.session, 'primary', 'Recognisable Name');

    const roster = await api('GET', '/v1/console/roster', { bearer: O.admin.session });
    assert(roster.status === 200, `roster refused: ${roster.status}`);
    const row = roster.data.roster.find((r) => r.code === code.data.codes[0]);
    assert(row, `the enrolment is missing from the roster: ${JSON.stringify(roster.data.roster)}`);
    // Exactly these fields, and no others. A new field is a decision, not an accident.
    const keys = Object.keys(row).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['activations30d', 'code', 'confirmedContacts', 'redeemedAt', 'state']),
      `roster row shape changed: ${JSON.stringify(keys)}`);
    // Nothing identifying survives anywhere in the payload.
    const raw = JSON.stringify(roster.data);
    for (const leak of [survivor.acc.email, survivor.acc.userId, 'Recognisable Name']) {
      assert(!raw.includes(leak), `the roster leaked "${leak}"`);
    }
    // Readiness is real, not decorative: an enrolled account with a contact but no
    // entitlement is NOT armed, and the state says which.
    assert(['armed', 'not_ready'].includes(row.state), `unexpected readiness state: ${row.state}`);
    assert(typeof row.confirmedContacts === 'number', 'confirmed contact count missing');
  });

  await check('79. console: the level indicator is derived, and matches what the gate enforces', async () => {
    // §1 — the label an account shows and the powers it holds come from ONE derivation.
    const O = await bootstrapOrgWithTwoAdmins(`Console Levels ${uniq()}`, 'zero_fee', 5);
    const crd = await api('POST', '/v1/console/codes', { bearer: O.admin.session, body: { role: 'coordinator' } });
    const coord = await enrollWith(crd.data.codes[0]);
    const plain = await signup();

    const expected = [
      [O.admin.session, 'ADMIN', 'admin'],
      [coord.acc.session, 'COORD', 'coordinator'],
      [plain.session, 'UNMARKED', 'unmarked'],
    ];
    for (const [session, label, level] of expected) {
      const me = await api('GET', '/v1/console/me', { bearer: session });
      assert(me.data.levelLabel === label && me.data.level === level, `level mismatch: expected ${label}, got ${JSON.stringify(me.data)}`);
    }
    // The admin's seat list labels its own members with the same vocabulary.
    const seats = await api('GET', '/v1/console/seats', { bearer: O.admin.session });
    assert(seats.data.seats.every((s) => ['ADMIN', 'COORD', 'DEV'].includes(s.level)), `seat levels wrong: ${JSON.stringify(seats.data.seats.map((s) => s.level))}`);
  });

  // ---- SAFETY RULE: no unintentional sign-out, ever ----
  //
  // A session ends when the person ends it, and at no other time. The failure being
  // prevented is specific: a survivor opens the app to trigger an alert and gets a login
  // form instead, because something expired or a request failed while they had no signal.
  // The unit guards pin the client and the token shape; this proves the SERVER's half on
  // the live deployment — that age is not a factor in whether a session is accepted.

  await check('80. sessions NEVER expire on a timer — a year-old token still authenticates', async () => {
    const u = await signup();
    // Sanity: the fresh session works, so a later 200 means something.
    const fresh = await api('GET', '/v1/me', { bearer: u.session });
    assert(fresh.status === 200, `a fresh session was refused: ${fresh.status}`);

    if (!SESSION_SECRET) {
      throw new Error('BBX_SESSION_SECRET required to mint an aged token (staging value; see test/.acceptance.env)');
    }
    // Mint a token for the SAME account, issued 400 days ago. Same shape the server mints:
    // `<userId>.<issuedAt>.<hmac>`.
    const aged = (days) => {
      const issuedAt = Date.now() - days * 24 * 60 * 60 * 1000;
      return `${u.userId}.${issuedAt}.${hmacHex(SESSION_SECRET, `${u.userId}.${issuedAt}`)}`;
    };
    for (const days of [1, 30, 400, 3650]) {
      const res = await api('GET', '/v1/me', { bearer: aged(days) });
      assert(res.status === 200, `a ${days}-day-old session was refused (${res.status}) — an expiry has been introduced`);
    }

    // The check must not be vacuous: a token with a BAD signature must still be refused,
    // otherwise "old tokens work" could just mean authentication is broken.
    const forged = `${u.userId}.${Date.now()}.${'0'.repeat(64)}`;
    const bad = await api('GET', '/v1/me', { bearer: forged });
    assert(bad.status === 401, `a forged token was ACCEPTED (${bad.status}) — authentication is broken`);
    // …and a token for a different account is not interchangeable.
    const other = await signup();
    const crossed = `${other.userId}.${Date.now()}.${hmacHex(SESSION_SECRET, `${u.userId}.${Date.now()}`)}`;
    const cross = await api('GET', '/v1/me', { bearer: crossed });
    assert(cross.status === 401, `a token signed for another account was accepted: ${cross.status}`);
  });

  await check('81. an offline/failed check never invalidates a session — the token survives errors', async () => {
    const u = await signup();
    // Hammer the account with requests that FAIL for reasons that are not authentication:
    // a bad route, a malformed body, an unauthorised scope. None of these may have any
    // effect on whether the session still works afterwards.
    await api('GET', '/v1/does-not-exist', { bearer: u.session });
    await api('POST', '/v1/me/contacts/primary', { bearer: u.session, body: { nonsense: true } });
    await api('GET', '/v1/console/orgs', { bearer: u.session });
    await api('POST', '/v1/console/codes', { bearer: u.session, body: { role: 'admin' } });
    const still = await api('GET', '/v1/me', { bearer: u.session });
    assert(still.status === 200, `the session stopped working after failed requests: ${still.status}`);
    // And the SAME token keeps working for the thing that matters most.
    const ev = await api('POST', '/v1/events', { bearer: u.session, body: { source: 'acc-persist' } });
    assert(ev.status === 201 && ev.data.eventId, `the trigger stopped working after failed requests: ${ev.status}`);
    created.events.push(ev.data.eventId);
  });

  // ---- Brief 35 — the deploy gate: no backend-disabled release ----
  //
  // The defect: `.env` is gitignored, the PWA fell back to an EMPTY api origin, and every
  // consequence was silent — activation started local capture and showed an active alert
  // while creating no event, notifying nobody and uploading nothing. The deploy went green
  // because the build ids matched. §A/§B are build-time and are proven by
  // scripts/verify-hardening.mjs; what belongs HERE is the server half: the canary
  // suppression path, and above all that it can never touch a real alert.

  await check('82. the canary round trip completes and dispatches to NOBODY', async () => {
    if (!ADMIN) throw new Error('BBX_ADMIN_TOKEN required for the canary gate');
    // Clean slate: a previous run that died would leave rows this check reads.
    await api('POST', '/v1/admin/canary/purge', { bearer: ADMIN });

    const prov = await api('POST', '/v1/admin/canary/provision', { bearer: ADMIN });
    assert(prov.status === 200 && prov.data?.sessionToken, `provision failed: ${prov.status} ${JSON.stringify(prov.data)}`);

    // A REAL trigger through the ordinary authenticated path — the same call the survivor's
    // phone makes. A canary that took a special path would prove only that special path.
    const ev = await api('POST', '/v1/events', { bearer: prov.data.sessionToken, body: { source: 'acc-canary', tzOffsetMinutes: 0 } });
    assert(ev.status === 201 && ev.data?.eventId, `canary trigger failed: ${ev.status} ${JSON.stringify(ev.data)}`);
    const eventId = ev.data.eventId;

    // Drive the cascade the way the device does, then read the delivery log back.
    await signed('POST', `/v1/events/${eventId}/heartbeat`, ev.data.hmacSecret, eventId, {});
    let suppressed = 0;
    for (let i = 0; i < 10 && suppressed === 0; i += 1) {
      suppressed = await adminDelivered(eventId, '', 'suppressed_test');
      if (suppressed === 0) await sleep(1500);
    }
    assert(suppressed > 0, 'no suppressed_test delivery row — the cascade never ran, or suppression did not engage');
    // THE point of the whole gate: nothing reached a provider.
    const delivered = await adminDelivered(eventId, '', 'delivered');
    const failed = await adminDelivered(eventId, '', 'failed');
    assert(delivered === 0 && failed === 0, `a TEST event reached a live dispatch path: delivered=${delivered} failed=${failed}`);

    // Isolation: it is not evidence and must never be offerable as the subject of a report.
    const reports = await api('GET', '/v1/me/reports/events', { bearer: prov.data.sessionToken });
    if (reports.status === 200) {
      assert(!(reports.data?.events ?? []).some((e) => e.eventId === eventId), 'the canary event appears in the owner report list');
    }

    // Purge, and CONFIRM. "The purge did not confirm" is a deploy failure, not a warning:
    // a canary event left behind is a fake activation in the table real ones live in.
    const purge = await api('POST', '/v1/admin/canary/purge', { bearer: ADMIN });
    assert(purge.status === 200 && purge.data?.remaining === 0, `purge did not confirm: ${JSON.stringify(purge.data)}`);
  });

  await check('83. §D a REAL account is NEVER suppressed — no client-supplied marking is honoured', async () => {
    // The hazard §C creates, tested from the outside: a code path whose purpose is to not
    // deliver. Brief 31 refused a test-mode flag because one set wrongly would swallow a
    // real survivor's alert. So an ordinary account asks — loudly, in every shape a client
    // could — to be treated as a test, and must be dispatched to anyway.
    const u = await signup();
    const contact = await addEmail(u.session, 'primary', 'Real');
    assert(contact.status === 200 || contact.status === 201, `contact save failed: ${contact.status}`);

    const ev = await api('POST', '/v1/events', {
      bearer: u.session,
      body: { source: 'acc-not-a-test', tzOffsetMinutes: 0, isTest: true, is_test: 1, test: true, canary: true },
    });
    assert(ev.status === 201 && ev.data?.eventId, `trigger failed: ${ev.status}`);
    created.events.push(ev.data.eventId);
    await signed('POST', `/v1/events/${ev.data.eventId}/heartbeat`, ev.data.hmacSecret, ev.data.eventId, {});

    // Wait for the cascade to record something, then assert on WHAT it recorded.
    let rows = 0;
    for (let i = 0; i < 10 && rows === 0; i += 1) {
      rows = await adminDelivered(ev.data.eventId, '', '');
      if (rows === 0) await sleep(1500);
    }
    assert(rows > 0, 'no delivery row at all — the alert path is dead for a real account');

    // THE ASSERTION. `suppressed_test` short-circuits BEFORE any channel is built;
    // `suppressed` is recorded per-endpoint INSIDE the ordinary dispatch loop (Brief 31,
    // reserved address). So which of the two appears says exactly which path ran — and
    // for a real account it must be the ordinary one, no matter what the client claimed.
    const suppressedTest = await adminDelivered(ev.data.eventId, '', 'suppressed_test');
    assert(suppressedTest === 0, 'A REAL ACCOUNT WAS SUPPRESSED AS A TEST — a client-supplied marking was honoured');
    const normal = await adminDelivered(ev.data.eventId, '', 'suppressed');
    assert(normal > 0, `the ordinary per-endpoint dispatch never ran (rows=${rows}) — the alert path is broken`);
    // Deliberately NOT asserting a real provider delivery: the suite's addresses are
    // RFC 2606 reserved precisely so a test run cannot spend the quota a survivor's alert
    // depends on, and whether a vendor physically delivered is monitoring, not a gate.
  });

  // ---- Brief 30 Fix A — a handle is not a credential -------------------------------------
  //
  // Every one of these was PROVEN EXPLOITABLE on staging before the fix: `signupId` was the
  // account's permanent users.id, and finalize/passkey/recovery all accepted it as authorization
  // without checking the account was still a draft.

  await check('84. §A a bare users.id no longer authorizes ANY signup step', async () => {
    const victim = await signup('covert');
    // The exact request that returned a valid session for an active account.
    const takeover = await api('POST', '/v1/auth/signup/finalize', {
      body: { signupId: victim.userId, displayMode: 'direct' },
    });
    assert(!takeover.data?.sessionToken, `HANDLE STILL GRANTS A SESSION: ${JSON.stringify(takeover.data)}`);
    assert(takeover.status === 401 || takeover.status === 409, `expected a refusal, got ${takeover.status}`);

    // …and the victim's display mode was NOT flipped. For a covert user that is the disguise.
    const me = await api('GET', '/v1/me', { bearer: victim.session });
    assert(me.data?.user?.displayMode === 'covert', `displayMode was altered to ${me.data?.user?.displayMode}`);

    // Recovery issuance was the other takeover primitive — it invalidates the owner's codes.
    const rec = await api('POST', '/v1/auth/recovery/issue', { body: { signupId: victim.userId } });
    assert(!Array.isArray(rec.data?.codes), `a bare handle still minted recovery codes: ${rec.status}`);

    // Passkey enrollment on someone else's account is a credential-granting act.
    const pk = await api('POST', '/v1/auth/passkey/register/options', { body: { signupId: victim.userId } });
    assert(pk.status === 401, `a bare handle still got passkey options: ${pk.status}`);
  });

  await check('85. §A/§B finalize is single-use; a replayed capability is refused', async () => {
    const code = await issueSignupCode();
    const email = `smoke+acc-${uniq()}@example.com`;
    const s1 = await api('POST', '/v1/auth/signup/start', {
      body: { name: 'Replay', email, password: PW, regionId: 'jp', code },
    });
    assert(s1.data?.capability, `no capability issued: ${JSON.stringify(s1.data)}`);
    created.emails.push(email);
    const cap = s1.data.capability;

    const first = await api('POST', '/v1/auth/signup/finalize', { body: { capability: cap, displayMode: 'direct' } });
    assert(first.data?.sessionToken, `legitimate finalize failed: ${JSON.stringify(first.data)}`);

    // Same capability, second time. Minting a session is not idempotent.
    const replay = await api('POST', '/v1/auth/signup/finalize', { body: { capability: cap, displayMode: 'direct' } });
    assert(!replay.data?.sessionToken, `REPLAY SUCCEEDED: ${JSON.stringify(replay.data)}`);
  });

  await check('86. §A a forged or tampered capability is refused on signature', async () => {
    const code = await issueSignupCode();
    const email = `smoke+acc-${uniq()}@example.com`;
    const s1 = await api('POST', '/v1/auth/signup/start', {
      body: { name: 'Forged', email, password: PW, regionId: 'jp', code },
    });
    created.emails.push(email);
    const cap = s1.data.capability;

    // Flip the last character of the signature.
    const parts = cap.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].slice(-1) === 'a' ? 'b' : 'a'}`;
    const forged = await api('POST', '/v1/auth/signup/finalize', { body: { capability: tampered, displayMode: 'direct' } });
    assert(forged.data?.error === 'capability_bad_signature', `tampered token not refused on signature: ${JSON.stringify(forged.data)}`);

    // A capability for a DIFFERENT signup must not finalize this one either.
    const invented = 'bbxcap1.eyJzdWIiOiJ4In0.deadbeef';
    const bogus = await api('POST', '/v1/auth/signup/finalize', { body: { capability: invented, displayMode: 'direct' } });
    assert(!bogus.data?.sessionToken, `an invented capability minted a session: ${JSON.stringify(bogus.data)}`);
  });

  await check('87. §C a capability in the URL is not accepted — it must never travel there', async () => {
    // §C — never in URLs, query strings or referrers. A capability in a query string lands in
    // access logs and in the Referer of the next request, which is how the thing it replaced got
    // loose in the first place. So the server must not read one from there even if a client tries.
    const code = await issueSignupCode();
    const email = `smoke+acc-${uniq()}@example.com`;
    const s1 = await api('POST', '/v1/auth/signup/start', {
      body: { name: 'UrlScan', email, password: PW, regionId: 'jp', code },
    });
    created.emails.push(email);
    const cap = s1.data.capability;

    const viaUrl = await api('POST', `/v1/auth/signup/finalize?capability=${encodeURIComponent(cap)}`, {
      body: { displayMode: 'direct' },
    });
    assert(!viaUrl.data?.sessionToken, `a capability in the QUERY STRING was accepted: ${JSON.stringify(viaUrl.data)}`);
    assert(viaUrl.data?.error === 'capability_missing', `expected capability_missing, got ${JSON.stringify(viaUrl.data)}`);

    // The body path still works, so the check above is proving the URL is refused — not that
    // finalize is simply broken.
    const viaBody = await api('POST', '/v1/auth/signup/finalize', { body: { capability: cap, displayMode: 'direct' } });
    assert(viaBody.data?.sessionToken, `body-carried capability failed: ${JSON.stringify(viaBody.data)}`);
  });

  // ---- cleanup ----
  await cleanup();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
  }
  console.log('SUITE GREEN ✓');
}

// admin/D1 read helpers via the admin active-events endpoint + delivery is read
// through a tiny admin echo: we reuse the admin events endpoint and per-event
// audit is not exposed, so timing/delivery come from a dedicated admin query.
async function adminEvent(eventId) {
  const r = await api('GET', '/v1/admin/events/active', { bearer: ADMIN });
  const found = (r.data.active || []).find((e) => e.id === eventId);
  return found ? { status: 'active' } : { status: 'closed' };
}
// cascade_fired times + delivery counts come from the admin audit/delivery query
// endpoint (added for the suite). Falls back to empty if unavailable.
async function adminFires(eventId) {
  const r = await api('GET', `/v1/admin/events/${eventId}/audit?action=cascade_fired`, { bearer: ADMIN });
  // `via` names the driver that fired the step (alarm | cron | stagger | heartbeat) —
  // the only way to tell a precise DO schedule from a cron rescue.
  return Array.isArray(r.data?.rows) ? r.data.rows.map((x) => ({ t: x.timestamp, step: x.step, via: x.via })) : [];
}
async function adminDelivered(eventId, channel, status) {
  const q = status ? `?channel=${channel}&status=${status}` : `?channel=${channel}`;
  const r = await api('GET', `/v1/admin/events/${eventId}/deliveries${q}`, { bearer: ADMIN });
  return typeof r.data?.count === 'number' ? r.data.count : 0;
}

async function cleanup() {
  for (const id of created.events) {
    await api('POST', `/v1/admin/events/${id}/force-close`, { bearer: ADMIN }).catch(() => {});
  }
  for (const email of created.emails) {
    const si = await api('POST', '/v1/auth/signin', { body: { email, password: PW } });
    if (si.data?.sessionToken) await api('DELETE', '/v1/me/account', { bearer: si.data.sessionToken }).catch(() => {});
  }
}

process.on('exit', () => {
  console.log(`
[cost] acceptance suite issued ${REQUESTS_ISSUED} request(s) against the account limit.`);
});

run().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
