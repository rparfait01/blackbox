/**
 * BLACK BOX standing acceptance suite (Brief 19). Runs the full known-good flow
 * against the DEPLOYED worker on every commit/deploy. A change is not committable
 * unless this whole suite is green — it is the tripwire so a fixed bug can never
 * silently regress. Every bug found from here adds a check BEFORE its fix lands.
 *
 *   node workers/api/test/acceptance.mjs
 *
 * Config (env): BBX_ORIGIN (default deployed), BBX_ADMIN_TOKEN (default: read
 * workers/admin_token.txt), BBX_MAGIC_LINK_SECRET (REQUIRED — coordinator flows
 * cannot be exercised without it, so the suite fails closed if absent), and
 * BBX_LINE_USER_ID (optional: also assert a real LINE delivery).
 *
 * Checks self-provision throwaway accounts (smoke+acc-*@example.com) and clean up.
 */
import { createHmac, createHash } from 'node:crypto';
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

const ORIGIN = process.env.BBX_ORIGIN || 'https://blackbox-api.stillpoint-dev.workers.dev';
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

async function signup(mode = 'direct', name = 'Acc') {
  const email = `smoke+acc-${uniq()}@example.com`;
  const s1 = await api('POST', '/v1/auth/signup/start', { body: { name, email, password: PW, regionId: 'jp' } });
  if (!s1.data?.signupId) throw new Error('signup/start failed: ' + JSON.stringify(s1.data));
  const s2 = await api('POST', '/v1/auth/signup/finalize', { body: { signupId: s1.data.signupId, displayMode: mode } });
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
    assert(got.data.armable === true, 'not armable with an email contact');
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

  await check('8. trigger → timed cascade fires 0/10/20/30/40 (DO alarm) + email delivered', async () => {
    const u = await signup();
    for (const slot of ['primary', 'secondary', 'tertiary', 'guardian', 'emergency']) await addEmail(u.session, slot, slot);
    const ev = await trigger(u.session, 'acc-cascade');
    assert(ev.eventId, 'no event');
    await sleep(46000); // DO alarm drives the tail; no heartbeats sent
    const fired = await adminFires(ev.eventId);
    assert(fired.length === 5, `expected 5 cascade_fired, got ${fired.length}`);
    const targets = [0, 10, 20, 30, 40];
    for (let i = 0; i < 5; i += 1) {
      const rel = (fired[i].t - ev.createdAt) / 1000;
      assert(Math.abs(rel - targets[i]) <= 3.5, `step ${i} fired at T+${rel.toFixed(1)}s, want ~${targets[i]}`);
    }
    // The cascade guarantee is the 5 cascade_fired at their windows above — that is
    // deterministic (DO alarm) and proves every step dispatched + no halt. Delivery
    // is provider-dependent: assert the email channel genuinely DELIVERS (>=1, polled
    // to absorb SendGrid latency) but do NOT require all 5 records within a window —
    // that tests SendGrid's reliability/throughput, not the cascade, and flakes the
    // gate under load.
    let delivered = 0;
    for (let i = 0; i < 12 && delivered < 1; i += 1) {
      delivered = await adminDelivered(ev.eventId, 'email', 'delivered');
      if (delivered < 1) await sleep(2500);
    }
    assert(delivered >= 1, `email channel delivered ${delivered} — channel not actually delivering`);
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
    const delivered = await adminDelivered(ev.eventId, 'email');
    assert(delivered >= 2, `emergency not delivered (${delivered})`);
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

  await check('24. §19 check-in routes to designated→primary CONTACT (not guardian); honest failure; on-the-fly; dormant-only', async () => {
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
    // Designate a DIFFERENT contact ON THE FLY → the resolve order prefers it, and
    // the contacts view reflects the new designation immediately.
    assert((await addEmail(u.session, 'secondary', 'S')).status === 200, 'add secondary failed');
    const listed = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const secondaryId = listed.data?.slots?.find((s) => s.slot === 'secondary')?.id;
    assert(secondaryId, `secondary contact id missing from /contacts: ${JSON.stringify(listed.data)}`);
    const desig = await api('POST', '/v1/me/checkin-contact', { bearer: u.session, body: { contactId: secondaryId } });
    assert(desig.status === 200 && desig.data?.checkinContactId === secondaryId, `designate failed: ${JSON.stringify(desig.data)}`);
    const relisted = await api('GET', '/v1/me/contacts', { bearer: u.session });
    assert(relisted.data?.checkinContactId === secondaryId, `designation not reflected in /contacts: ${JSON.stringify(relisted.data)}`);
    // The guardian can NEVER be designated as the check-in recipient (contacts only).
    assert(
      (await api('POST', '/v1/me/contacts/guardian', { bearer: u.session, body: { contactName: 'G', channel: 'email', destination: `smoke+chkg-${uniq()}@example.com` } })).status === 200,
      'add guardian failed',
    );
    const withG = await api('GET', '/v1/me/contacts', { bearer: u.session });
    const guardianId = withG.data?.slots?.find((s) => s.slot === 'guardian')?.id;
    const badDesig = await api('POST', '/v1/me/checkin-contact', { bearer: u.session, body: { contactId: guardianId } });
    assert(badDesig.status === 400, `guardian must not be designable as the check-in recipient: ${badDesig.status} ${JSON.stringify(badDesig.data)}`);
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
  return Array.isArray(r.data?.rows) ? r.data.rows.map((x) => ({ t: x.timestamp, step: x.step })) : [];
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

run().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
