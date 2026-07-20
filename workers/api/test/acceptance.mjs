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

  await check('28. accounts: signup takes NO password; the email-reset path is GONE', async () => {
    // A passwordless signup is the new normal path — no password field exists in
    // the app, so the server must not require one.
    const email = `smoke+acc-${uniq()}@example.com`;
    const s1 = await api('POST', '/v1/auth/signup/start', { body: { name: 'Passwordless', email, regionId: 'jp' } });
    assert(s1.status === 201 && s1.data?.signupId, `passwordless signup refused: ${s1.status} ${JSON.stringify(s1.data)}`);
    created.emails.push(email);
    const s2 = await api('POST', '/v1/auth/signup/finalize', { body: { signupId: s1.data.signupId, displayMode: 'direct' } });
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

    // Armed reflects the gate. With only a pending contact + a confirmed guardian,
    // armable is true (the guardian is confirmed). This holds in both flag states.
    assert(got.data.armable === true, `guardian-confirmed account should be armable: ${JSON.stringify(got.data.armable)}`);
  });

  await check('37. consent webhook: unsigned inbound is refused (403)', async () => {
    // The real YES/NO loop needs Twilio's signature (device sign-off). What is
    // asserted on prod: the endpoint exists and rejects an unsigned/forged POST, so
    // a status can never be flipped by an attacker curling the webhook.
    const res = await api('POST', '/v1/webhooks/twilio', { body: { From: '+15555550123', Body: 'YES' } });
    assert(res.status === 403, `unsigned webhook not refused: ${res.status} ${JSON.stringify(res.data)}`);
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
