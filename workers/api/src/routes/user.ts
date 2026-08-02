/**
 * User-scoped profile + settings (W8A). All session-protected. Profile name /
 * email / phone editing is read-only in v0 (email/phone changes are deferred);
 * display mode, region, and the lock/duress codes are editable.
 */

import { Hono } from 'hono';
import { requireSession } from '../auth';
import { purgeCaptureOnConsent } from '../lib/consented-purge';
import { listDevices, registerDevice, revokeDevice } from '../lib/device-credential';
import { destinationProblem, getInviteForUser, normalizeDestination, type PreferredChannel } from '../lib/guardians';
import { pairingStatus, startLinePairing } from '../lib/line-pairing';
import { deleteAccount, getUserById, hasActiveEvent, setGuardianEnabled, updateUserFields } from '../lib/users';
import {
  guardianLoad,
  hasDeliverableRecipient,
  listSlots,
  removeSlot,
  upsertSlot,
  type SlotKey,
} from '../lib/roles';
import { sendCheckin } from '../lib/checkin';
import { isChannelDeliverable } from '../channels/router';
import { sendConfirmationAsk } from '../lib/consent';
import { checkRedeemRate, leaveOrg, redeemCode } from '../lib/enrollment';
import { isEntitled } from '../lib/entitlement';
import { confirmActivation } from './activation';
import { normalizeSubmission, submitTally } from '../lib/tally';
import { normalizeIntakeStat, submitIntakeStat } from '../lib/intake-stats';
import { getAccountKeys, getRecoveryKey, getSurvivorCaptureEnvelope, setRecoveryKey, setUserPubkey } from '../lib/zk-custody';
import { envelopeEnabled, getCaseFileSealed, listCaseFiles, storeCaseFile } from '../lib/case-files';
import { signReportAttestation } from '../lib/report-attestation';
import { getOwnChunkBytes, getReportMetadata, listOwnEvents } from '../lib/report-metadata';
import { audit } from '../lib/audit';
import type { Env, Vars } from '../types';

export const userRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

userRoutes.use('*', requireSession);

/** 423 Locked if the user has an active alert (Fix Brief 4 S1). */
async function lockedDuringAlert(c: { env: Env; get: (k: 'userId') => string }): Promise<boolean> {
  return hasActiveEvent(c.env, c.get('userId'));
}

// Brief 23 §3 — the SURVIVOR's own enrollment controls (their account stays theirs).
// Redeeming a code is the explicit, consented individual→org migration path; leaving
// is the reversal. Both are account changes, so both respect the live-alert lock like
// contact edits and delete. Past events keep their stamped org — history preserved.
userRoutes.post('/org/redeem', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  const code = (body.code ?? '').trim();
  if (!code) {
    return c.json({ error: 'code_required' }, 400);
  }
  // Brief 28 §4 — per-account brute-force guard: readable codes are shorter, so cap
  // redemption attempts. 429 past the ceiling (counts every attempt, before lookup).
  if (!(await checkRedeemRate(c.env, c.get('userId'), Date.now()))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const res = await redeemCode(c.env, code, c.get('userId'));
  if (!res.ok) {
    return c.json({ error: res.reason }, 400);
  }
  return c.json({ ok: true, orgId: res.orgId, role: res.role }, 200);
});

// Brief 28 §3 — a signed-in buyer confirms activation after a web checkout. Re-checks
// the SERVER's verified receipt (never a client claim); grants only if one exists.
userRoutes.post('/activation/confirm', confirmActivation);

userRoutes.post('/org/leave', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const res = await leaveOrg(c.env, c.get('userId'));
  if (!res.ok) {
    // Blocked: you are the second-to-last admin (§0/§6 — the org must keep two).
    return c.json({ error: res.reason, message: 'Your organisation must keep at least two admins. Add another admin before leaving.' }, 409);
  }
  return c.json({ ok: true, left: res.left }, 200);
});

// Brief 26 — zero-knowledge custody key material (dormant until the flag is armed). The
// survivor publishes ONLY their public key; the private half never leaves the device.
// A capture client fetches the keys it must wrap a data key to (its own + the org's).
userRoutes.post('/pubkey', async (c) => {
  const body = await c.req.json<{ pubkey?: string }>().catch(() => ({}) as { pubkey?: string });
  const pubkey = (body.pubkey ?? '').trim();
  if (!pubkey) {
    return c.json({ error: 'pubkey_required' }, 400);
  }
  await setUserPubkey(c.env, c.get('userId'), pubkey);
  return c.json({ ok: true }, 200);
});

userRoutes.get('/keys', async (c) => {
  return c.json(await getAccountKeys(c.env, c.get('userId')), 200);
});

// Decision A — the survivor's recovery-wrapped private key (opaque to the server). Stored
// so a new device + the recovery code can restore it; the server never sees the code or
// the private key in clear.
userRoutes.post('/recovery-key', async (c) => {
  const body = await c.req.json<{ wrapped?: string }>().catch(() => ({}) as { wrapped?: string });
  const wrapped = (body.wrapped ?? '').trim();
  if (!wrapped) {
    return c.json({ error: 'wrapped_required' }, 400);
  }
  await setRecoveryKey(c.env, c.get('userId'), wrapped);
  return c.json({ ok: true }, 200);
});

userRoutes.get('/recovery-key', async (c) => {
  return c.json({ wrapped: await getRecoveryKey(c.env, c.get('userId')) }, 200);
});

// Brief 26 state 6 (Review) — the OWNING survivor fetches their capture's wrapped DEK +
// commitments to decrypt it client-side. Fetching the key is the audited decrypt point
// (the invariant: every decrypt is logged — who, what, when); the actual decrypt happens
// on the survivor's device, never here. Ownership is enforced in the helper.
userRoutes.get('/events/:id/envelope', async (c) => {
  const eventId = c.req.param('id');
  const envelope = await getSurvivorCaptureEnvelope(c.env, c.get('userId'), eventId);
  if (!envelope) {
    return c.json({ envelope: null }, 200);
  }
  await audit(c.env, eventId, 'decrypt_review', c.get('userId'), { via: 'survivor' });
  return c.json({ envelope }, 200);
});

// Brief 27 §2 — file a case file. THE SECOND FAIL-CLOSED GATE: the server refuses to store
// a case file unless zero-knowledge custody is armed, so no path — client or server — ever
// persists an unencrypted disclosure. The body carries ONLY the sealed envelope; a plaintext
/**
 * Is this string a sealed envelope, structurally? Shape only — every field is opaque to us.
 * Matches what the client's sealer emits (lib/crypto/envelope: alg / epk / iv / ct) and what
 * the decryptor requires, so anything the survivor's own device could later OPEN passes, and
 * a bare JSON object of readable fields does not.
 */
function isSealedEnvelope(value: string): boolean {
  try {
    const env = JSON.parse(value) as Record<string, unknown>;
    return (
      typeof env.alg === 'string' &&
      env.alg.length > 0 &&
      typeof env.epk === 'string' &&
      env.epk.length > 0 &&
      typeof env.iv === 'string' &&
      env.iv.length > 0 &&
      typeof env.ct === 'string' &&
      env.ct.length > 0
    );
  } catch {
    return false;
  }
}

// case file has no column to land in and no endpoint to reach.
userRoutes.post('/case-files', async (c) => {
  if (!envelopeEnabled(c.env)) {
    // Fail-closed: secure storage is off, so nothing is written. Honest, specific refusal.
    return c.json({ error: 'envelope_disabled', message: 'Secure storage is not enabled — a report cannot be filed yet.' }, 409);
  }
  const body = await c.req
    .json<{ sealedCaseFile?: string; taxonomyVersion?: string }>()
    .catch(() => ({}) as { sealedCaseFile?: string; taxonomyVersion?: string });
  const sealedCaseFile = (body.sealedCaseFile ?? '').trim();
  const taxonomyVersion = (body.taxonomyVersion ?? '').trim();
  if (!sealedCaseFile || !taxonomyVersion) {
    return c.json({ error: 'sealed_case_file_required' }, 400);
  }
  // THE SERVER CHECKS THE SEAL ITSELF. Until arming, the client's fail-closed sealing was the
  // only thing standing between us and a plaintext case file — and "the client always seals"
  // is a habit, not a guarantee. Arming custody made that testable and the acceptance suite
  // immediately stored `{"notes":"he hit me"}` as a "sealed" file, 201.
  //
  // So the shape is verified here: an envelope has an alg, an ephemeral public key, an IV and
  // a ciphertext. We validate the SHAPE only — we cannot and must not be able to read it, and
  // a wrong key still produces a valid-shaped envelope we simply cannot open. That is the
  // point: this refuses plaintext without granting the server any ability to decrypt.
  if (!isSealedEnvelope(sealedCaseFile)) {
    return c.json(
      { error: 'not_sealed', message: 'A case file must be sealed under your own key before it can be stored.' },
      400,
    );
  }
  const row = await storeCaseFile(c.env, { userId: c.get('userId'), sealedCaseFile, taxonomyVersion });
  await audit(c.env, null, 'case_file_filed', c.get('userId'), { caseFileId: row.id, taxonomyVersion });
  return c.json({ ok: true, id: row.id, createdAt: row.createdAt }, 201);
});

// The owner's case files (metadata list, then the sealed blob per file for client-side
// review-decrypt). Owner-scoped; a non-owner can reach neither.
userRoutes.get('/case-files', async (c) => {
  return c.json({ caseFiles: await listCaseFiles(c.env, c.get('userId')) }, 200);
});

userRoutes.get('/case-files/:id', async (c) => {
  const sealed = await getCaseFileSealed(c.env, c.get('userId'), c.req.param('id'));
  if (!sealed) {
    return c.json({ sealedCaseFile: null }, 200);
  }
  await audit(c.env, null, 'case_file_read', c.get('userId'), { caseFileId: c.req.param('id') });
  return c.json({ sealedCaseFile: sealed }, 200);
});

// ---------------------------------------------------------------------------------------
// Brief 29 — CERTIFIED REPORT. Additive, owner-scoped, and gated on zero-knowledge custody.
//
// With ENVELOPE_ENCRYPTION_ENABLED off, all four endpoints below 404: there are no capture-
// time commitments to chain a certification to, so no report path exists at all (§5). The
// report is the SURVIVOR'S — every route is scoped to the caller's own events, and there is
// no org or operator route to any of it.
// ---------------------------------------------------------------------------------------

/** 404 (not 403) while the flag is down — the feature does not exist yet, rather than
 *  existing-but-refusing. Keeps the dormant surface indistinguishable from absent. */
function reportsOff(c: { env: Env; json: (body: unknown, status: 404) => Response }): Response | null {
  return envelopeEnabled(c.env) ? null : c.json({ error: 'not_found' }, 404);
}

/** The owner's own events, so she can choose which one to build a report from. */
userRoutes.get('/reports/events', async (c) => {
  const off = reportsOff(c);
  if (off) return off;
  return c.json({ events: await listOwnEvents(c.env, c.get('userId')) }, 200);
});

/** The generic details that auto-populate the evidence zone (§1.2) — event metadata,
 *  location, notifications, the chunk index, and the recorded CLASSIFICATIONS and
 *  TRANSCRIPTS the review dashboard's summary and transcript panels replay.
 *
 *  Owner-scoped; null for anything else. Ownership is checked on the EVENT before any
 *  child row is read, so a foreign eventId yields the same 404 whether or not it exists
 *  — this is not an existence oracle for another account's events.
 *
 *  Classifications and transcripts are a REPLAY of what was recorded during the incident,
 *  never a re-analysis: nothing is recomputed here, so the values cannot drift between
 *  reviews. See the custody note on ReportMetadata — these two are server-readable
 *  plaintext (pre-existing), unlike the chunk bytes. */
userRoutes.get('/reports/events/:id/metadata', async (c) => {
  const off = reportsOff(c);
  if (off) return off;
  const metadata = await getReportMetadata(c.env, c.get('userId'), c.req.param('id'));
  if (!metadata) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ metadata }, 200);
});

/** One stored chunk, STILL ENCRYPTED. The decryption happens on her device with her key
 *  (§1.3); this hands over ciphertext the server cannot open. Owner-scoped. */
userRoutes.get('/reports/events/:id/chunks/:sequence', async (c) => {
  const off = reportsOff(c);
  if (off) return off;
  const sequence = Number(c.req.param('sequence'));
  if (!Number.isInteger(sequence) || sequence < 0) {
    return c.json({ error: 'bad_sequence' }, 400);
  }
  const bytes = await getOwnChunkBytes(c.env, c.get('userId'), c.req.param('id'), sequence);
  if (!bytes) {
    return c.json({ error: 'not_found' }, 404);
  }
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
});

/**
 * §2 — sign the evidence zone. THE BODY CARRIES TWO HASHES AND NOTHING ELSE: the server
 * signs a fingerprint it cannot invert, so certification stays compatible with zero-
 * knowledge custody. The server binds its own commitments hash and integrity-chain head
 * into what it signs, so the certification attests to what BLACK BOX witnessed at capture
 * time rather than to a claim the device made afterwards.
 *
 * Refusals are honest and specific: a report that cannot be truthfully certified is not
 * certified at all.
 */
userRoutes.post('/reports/sign', async (c) => {
  const off = reportsOff(c);
  if (off) return off;
  const body = await c.req
    .json<{ eventId?: string; evidenceHash?: string; renderedHash?: string }>()
    .catch(() => ({}) as { eventId?: string; evidenceHash?: string; renderedHash?: string });
  const eventId = (body.eventId ?? '').trim();
  const evidenceHash = (body.evidenceHash ?? '').trim();
  const renderedHash = (body.renderedHash ?? '').trim();
  // Shape-check the hashes here so a malformed value can never reach the signing key.
  const isSha256Hex = (v: string): boolean => /^[0-9a-f]{64}$/.test(v);
  if (!eventId || !isSha256Hex(evidenceHash) || !isSha256Hex(renderedHash)) {
    return c.json({ error: 'evidence_hashes_required' }, 400);
  }

  const result = await signReportAttestation(c.env, {
    userId: c.get('userId'),
    eventId,
    evidenceHash,
    renderedHash,
    now: Date.now(),
  });

  if (!result.ok) {
    const status = result.reason === 'not_owner' ? 404 : 409;
    const message =
      result.reason === 'no_commitments'
        ? 'This recording has no capture-time commitments, so it cannot be certified.'
        : result.reason === 'no_signing_key'
          ? 'Certification is not available on this deployment.'
          : 'Not found.';
    return c.json({ error: result.reason, message }, status);
  }

  // The decrypt/certify point is audited (who, what, when) — the content is not, and could
  // not be: the server never held it.
  await audit(c.env, eventId, 'report_certified', c.get('userId'), {
    evidenceHash,
    chainSeq: result.signed.attestation.chainSeq,
  });
  return c.json(result.signed, 200);
});

// Brief 27 §5 Destination 1 — the survivor's per-submission OPT-IN to contribute anonymized
// structured fields. SEVERED: the session authenticates the send (spam floor + rate limit)
// but is NEVER written to the record; the row carries no userId/caseFileId and only the
// submission MONTH — never the filing instant, which would correlate it with the case file.
// DELIBERATELY NOT audited (an audit row would carry a correlatable timestamp + account).
userRoutes.post('/intake-stats', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const fields = normalizeIntakeStat(body);
  const res = await submitIntakeStat(c.env, c.get('userId'), fields, Date.now());
  if (!res.ok) {
    return c.json({ error: 'rate_limited', used: res.used, limit: res.limit }, 429);
  }
  return c.json({ ok: true }, 201);
});

// Brief 25 — Anonymous Incident Tally. The session authenticates the SENDER (for the
// per-account rate limit ONLY); the survivor's identity is NEVER written to the stored
// record (see lib/tally.ts). Live-alert-locked (§7): a calm, deliberate act, never
// taken under duress. The submission NEVER reads or derives from capture/event data —
// only the four closed-vocabulary answers reach the severed store.
userRoutes.post('/tally', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ kind?: unknown; roughlyWhen?: unknown; regionId?: unknown; reportedOfficial?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const closed = normalizeSubmission(body);
  // regionId is a jurisdiction label: accept ONLY a known region id (never a finer or
  // arbitrary string), else null. Coarse-by-construction.
  let regionId: string | null = null;
  if (typeof body.regionId === 'string' && body.regionId) {
    const known = await c.env.DB.prepare('SELECT id FROM regions WHERE id = ?')
      .bind(body.regionId)
      .first<{ id: string }>();
    regionId = known?.id ?? null;
  }
  const res = await submitTally(c.env, c.get('userId'), { ...closed, regionId }, Date.now());
  if (!res.ok) {
    // Honest status (§4): never a silent discard — the survivor must never believe
    // something was counted when it wasn't.
    return c.json({ error: 'rate_limited', used: res.used, limit: res.limit }, 429);
  }
  return c.json({ ok: true }, 201);
});

/**
 * §3 "Track" — what the account can see about ITSELF: how it is protected, who it
 * can reach, and when it last checked in. Self-view only.
 *
 * `lastCheckinAt` is read with its own query because USER_COLS deliberately does
 * not select it.
 */
async function accountState(
  env: Env,
  userId: string,
): Promise<{
  passkeys: number;
  hasRecoveryCode: boolean;
  contactsConfigured: number;
  lastCheckinAt: number | null;
}> {
  const [passkeys, recovery, slots, checkin] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE userId = ?')
      .bind(userId)
      .first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE userId = ? AND consumedAt IS NULL')
      .bind(userId)
      .first<{ n: number }>(),
    listSlots(env, userId),
    env.DB.prepare('SELECT lastCheckinAt FROM users WHERE id = ?')
      .bind(userId)
      .first<{ lastCheckinAt: number | null }>(),
  ]);
  return {
    passkeys: passkeys?.n ?? 0,
    hasRecoveryCode: (recovery?.n ?? 0) > 0,
    // The recipients an alert would actually fan out to — 'emergency' is the
    // unclaimed-tail fallback, not someone the survivor configured to be told.
    contactsConfigured: slots.filter((s) => s.filled && s.slot !== 'emergency').length,
    lastCheckinAt: checkin?.lastCheckinAt ?? null,
  };
}

userRoutes.get('/', async (c) => {
  const user = await getUserById(c.env, c.get('userId'));
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  const region = user.regionId
    ? await c.env.DB.prepare(
        'SELECT id, name, defaultEmergencyNumber, defaultLanguage FROM regions WHERE id = ?',
      )
        .bind(user.regionId)
        .first<{ id: string; name: string; defaultEmergencyNumber: string; defaultLanguage: string }>()
    : null;
  const invite = await getInviteForUser(c.env, user.id);
  return c.json(
    {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        displayMode: user.displayMode,
        regionId: user.regionId,
        nationality: user.nationality,
        hasDuressCode: user.duressCodeHash != null,
        // Entitlement (Brief 28). Surfaced so the client can cache it and decide the
        // ARM affordance offline — NEVER the trigger. An org_code / operator_grant
        // source means the client renders no price. Permanent once 'activated'.
        entitlement: user.entitlement,
        entitlementSource: user.entitlementSource,
        activatedAt: user.activatedAt,
      },
      // Server-truth live-alert flag (Brief 20 §1). The client gates settings entry
      // and refuses sign-out on THIS, not just its local session — so a device that
      // lost its local session can never open settings or sign out of a live alert.
      activeEvent: await hasActiveEvent(c.env, user.id),
      // §3 "Track": the account's own state, for the SELF-VIEW only. Strictly this
      // user's own row — there is no cross-account visibility anywhere here, and
      // Tenancy must not quietly turn this into one.
      account: await accountState(c.env, user.id),
      region,
      guardian: invite
        ? {
            name: invite.guardianName,
            relationship: invite.relationship,
            status: invite.status,
            channel: invite.preferredChannel,
            destination: invite.channelDestination,
          }
        : null,
    },
    200,
  );
});

userRoutes.post('/display-mode', async (c) => {
  const body = await c.req.json<{ displayMode?: string }>().catch(() => ({}) as Record<string, string>);
  if (body.displayMode !== 'direct' && body.displayMode !== 'covert') {
    return c.json({ error: 'displayMode must be direct or covert' }, 400);
  }
  await updateUserFields(c.env, c.get('userId'), { displayMode: body.displayMode });
  return c.json({ ok: true, displayMode: body.displayMode }, 200);
});

userRoutes.post('/region', async (c) => {
  const body = await c.req.json<{ regionId?: string }>().catch(() => ({}) as Record<string, string>);
  if (!body.regionId) {
    return c.json({ error: 'regionId required' }, 400);
  }
  await updateUserFields(c.env, c.get('userId'), { regionId: body.regionId });
  return c.json({ ok: true }, 200);
});


// --- Roles: contact slots + guardian ---
// Contact Consent §0 reduced the survivor-facing ceiling to ONE contact + guardian
// (people in these circumstances have deliberately narrowed networks; more slots
// does not serve them). That cap is enforced in the UI — the add screen only ever
// offers primary + guardian. The SERVER stays permissive on secondary/tertiary on
// purpose: the staggered activation cascade (primary→secondary→tertiary→guardian→
// emergency, Brief 11/17) is a load-bearing safety mechanism whose multi-step DO
// alarm timing is regression-tested here, and hard-removing the slots server-side
// would degrade that coverage for no safety gain — a UI that never offers a slot is
// the cap that matters. No pilot account has ever held more than one contact.
const VALID_SLOTS: SlotKey[] = ['primary', 'secondary', 'tertiary', 'guardian', 'emergency'];

userRoutes.get('/contacts', async (c) => {
  const userId = c.get('userId');
  const user = await getUserById(c.env, userId);
  const slots = await listSlots(c.env, userId);
  const guardianSlot = slots.find((s) => s.slot === 'guardian');
  const othersLoad =
    guardianSlot?.destination != null
      ? await guardianLoad(c.env, guardianSlot.destination, userId)
      : 0;
  // Brief 28 §2 — the two arm preconditions, computed once. entitled gates the ARM
  // affordance only (never the trigger); deliverable is the notify-no-one guard.
  const entitled = await isEntitled(c.env, userId);
  const deliverable = await hasDeliverableRecipient(c.env, userId);
  return c.json(
    {
      slots,
      guardianEnabled: (user?.guardianEnabled ?? 1) === 1,
      // Surface the guardian's load so the user can judge reliability (Brief 9 caps).
      guardianAlsoFailsafeFor: othersLoad,
      // Armability: true only when the account is ENTITLED (Brief 28 §2) AND at least
      // one recipient could ACTUALLY be reached on activation. The client gates the
      // activate affordance on this so the user can never arm into the notify-no-one
      // deadlock, and can never arm before activation. This is the ONLY place
      // entitlement gates anything — it gates the ARM AFFORDANCE, never the trigger:
      // POST /v1/events never reads entitlement, and its hasDeliverableRecipient check
      // there is recording-only ("THE BUTTON ALWAYS FIRES"). armReasons tells the
      // client WHICH precondition is missing so it shows the right prompt (activate vs
      // add a recipient) without ever conflating the two.
      armable: entitled && deliverable,
      armReasons: { entitled, hasDeliverableRecipient: deliverable },
      // Check-in routing is PRIMARY-ONLY and server-decided, so there is no
      // designation for the UI to read back. The Settings marker is rendered from the
      // primary slot itself — one source of truth, no field that could disagree
      // with resolveCheckinContact().
      // Which channels can ACTUALLY deliver right now — server truth, derived from
      // the same isChannelDeliverable the dispatcher and the save-guard use. The UI
      // renders from THIS rather than a hardcoded list, so the day Twilio is
      // provisioned SMS appears everywhere on its own and email disappears the day
      // it is retired — no client release, no list to forget to update. Channels are
      // inputs to one dispatcher; the UI has to reflect that or it drifts.
      deliverableChannels: (['sms', 'line', 'email'] as const).filter((ch) =>
        isChannelDeliverable(c.env, ch),
      ),
      // LINE is captured ONLY by QR (Brief 18) — it can never be a typed address,
      // which the UI needs to know to offer a usable backup channel.
      typeableChannels: (['sms', 'email'] as const).filter((ch) => isChannelDeliverable(c.env, ch)),
    },
    200,
  );
});

// NOTE: `POST /v1/me/checkin-contact` is GONE, not deprecated. Check-in routing is
// primary-only and decided by resolveCheckinContact() alone (see lib/checkin.ts). A
// route left in place "harmlessly" would still write a column the resolver no longer
// reads — a setting that appears to take effect and changes nothing, which is worse
// than a 404. Callers now get 404 from the router.
userRoutes.post('/contacts/:slot', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const slot = c.req.param('slot') as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  const body = await c.req
    .json<{
      contactName?: string;
      channel?: string;
      destination?: string;
      fallbackChannel?: string;
      fallbackDestination?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);
  const channel = body.channel as PreferredChannel | undefined;
  if (!body.contactName?.trim() || !body.destination?.trim()) {
    return c.json({ error: 'name and destination are required' }, 400);
  }
  if (channel !== 'sms' && channel !== 'line' && channel !== 'email') {
    return c.json({ error: 'channel must be sms, line or email' }, 400);
  }
  // LINE can NEVER be entered by hand (Brief 18): a userId is captured only via the
  // QR-connect pairing, which writes the slot itself. Refuse a manual LINE save so
  // no one ever types/looks up a LINE id.
  if (channel === 'line') {
    return c.json(
      {
        error: 'line_requires_pairing',
        channel,
        message: 'Connect LINE with the QR code — a LINE contact is captured by scanning, never typed.',
      },
      400,
    );
  }
  // Never accept a contact on a channel that cannot deliver in this deployment —
  // it would fail silently at alert time. Refuse with a clear, surfaced reason.
  if (!isChannelDeliverable(c.env, channel)) {
    return c.json(
      {
        error: 'channel_not_available',
        channel,
        message: `${channel.toUpperCase()} is not available yet — this contact would not be reached. Use Email.`,
      },
      400,
    );
  }
  // Reject a malformed destination (e.g. a LINE handle that is not a userId) up
  // front — it would 400 at the provider and never deliver. Never store it.
  const destProblem = destinationProblem(channel, body.destination.trim());
  if (destProblem) {
    return c.json({ error: 'invalid_destination', channel, message: destProblem }, 400);
  }
  // §2: the optional FALLBACK channel — what the dispatcher reaches for when the
  // preferred one fails. Validated to the same standard as the preferred channel:
  // a fallback that cannot deliver is not a fallback, it is a second silent
  // failure, so it is refused rather than stored and discovered mid-alert.
  let fallbackChannel: PreferredChannel | null = null;
  let fallbackDestination: string | null = null;
  if (body.fallbackChannel && body.fallbackDestination?.trim()) {
    const fb = body.fallbackChannel as PreferredChannel;
    if (fb !== 'sms' && fb !== 'line' && fb !== 'email') {
      return c.json({ error: 'invalid_fallback_channel', message: 'Fallback must be sms, line or email.' }, 400);
    }
    if (fb === 'line') {
      // Same rule as the preferred channel — LINE is only ever captured by QR.
      return c.json(
        { error: 'line_requires_pairing', channel: fb, message: 'Connect LINE with the QR code — never typed.' },
        400,
      );
    }
    if (fb === channel) {
      return c.json(
        {
          error: 'fallback_same_channel',
          message: 'The backup must be a different channel — the same one twice is the same failure twice.',
        },
        400,
      );
    }
    if (!isChannelDeliverable(c.env, fb)) {
      return c.json(
        {
          error: 'channel_not_available',
          channel: fb,
          message: `${fb.toUpperCase()} is not available yet — it could not be a backup.`,
        },
        400,
      );
    }
    const fbProblem = destinationProblem(fb, body.fallbackDestination.trim());
    if (fbProblem) {
      return c.json({ error: 'invalid_destination', channel: fb, message: fbProblem }, 400);
    }
    fallbackChannel = fb;
    fallbackDestination = normalizeDestination(fb, body.fallbackDestination.trim());
  }

  const user = await getUserById(c.env, c.get('userId'));
  const preferredDestination = normalizeDestination(channel, body.destination.trim());
  const upsert = await upsertSlot(c.env, c.get('userId'), slot, {
    contactName: body.contactName.trim(),
    userDisplayName: user?.name ?? 'BLACK BOX user',
    channel,
    destination: preferredDestination,
    fallbackChannel,
    fallbackDestination,
  });
  // §1: a newly-pending SMS contact receives ONE confirmation ask — the only
  // message they get until they reply. Off the response path (waitUntil): the save
  // already succeeded, and an SMS hiccup must not fail it. The survivor sees the
  // Pending state regardless of whether the send lands.
  if (upsert.confirmationNeeded) {
    const survivorName = user?.name ?? 'Someone';
    c.executionCtx.waitUntil(
      sendConfirmationAsk(c.env, preferredDestination, survivorName).then((sent) =>
        audit(c.env, null, sent ? 'consent.ask_sent' : 'consent.ask_failed', c.get('userId'), { slot }),
      ),
    );
  }
  return c.json({ ok: true, status: upsert.status }, 200);
});

userRoutes.delete('/contacts/:slot', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const slot = c.req.param('slot') as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  await removeSlot(c.env, c.get('userId'), slot);
  return c.json({ ok: true }, 200);
});

// QR-connect LINE pairing (Brief 18). Start a pairing for a slot → returns a deep
// link + QR carrying a one-tap prefilled token; the contact scans/sends it in LINE
// and the webhook binds their userId to the slot. No LINE id is ever typed.
userRoutes.post('/line-pairing/start', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req
    .json<{ slot?: string; contactName?: string }>()
    .catch(() => ({}) as { slot?: string; contactName?: string });
  const slot = body.slot as SlotKey;
  if (!VALID_SLOTS.includes(slot)) {
    return c.json({ error: 'invalid slot' }, 400);
  }
  if (!body.contactName?.trim()) {
    return c.json({ error: 'name required', message: 'Add a name first.' }, 400);
  }
  if (!isChannelDeliverable(c.env, 'line')) {
    return c.json({ error: 'channel_not_available', channel: 'line', message: 'LINE is not available yet.' }, 400);
  }
  const started = await startLinePairing(c.env, c.get('userId'), slot, body.contactName.trim());
  return c.json(started, 200);
});

// Poll a pairing's status (never returns the captured userId).
userRoutes.get('/line-pairing/status', async (c) => {
  const nonce = c.req.query('nonce') ?? '';
  const status = await pairingStatus(c.env, c.get('userId'), nonce);
  if (!status) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(status, 200);
});

// Delete account (Brief 13 B17). Behind a client confirmation; blocked during an
// active alert so an aggressor can't wipe the account to kill a live event.
userRoutes.delete('/account', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  // The user asked for this explicitly, so confirm is set here — without it the call
  // would preview and delete NOTHING, turning "delete my account" into a silent no-op.
  const result = await deleteAccount(c.env, c.get('userId'), { confirm: true });
  // Audited who/what/when. The row is written BEFORE the account row disappears.
  await audit(c.env, null, 'account.deleted', c.get('userId'), {
    events: result.events,
    chunks: result.chunks,
    r2Deleted: result.r2Deleted,
    via: 'self_service',
  });
  return c.json({ ok: true, ...result }, 200);
});

// Check-in ("I'm OK") — Brief 10. NON-emergency: no event, no capture. NOT
// locked during an alert (it's a separate, harmless reassurance ping).
userRoutes.post('/checkin', async (c) => {
  const body = await c.req
    .json<{ location?: { lat: number; lon: number } | null; tzOffsetMinutes?: number }>()
    .catch(() => ({}) as Record<string, never>);
  // Location is ALWAYS captured on tap (Brief 17 §1) — no opt-in flag. Carried
  // when the client resolved a fix; null when it couldn't.
  const location =
    body.location && typeof body.location.lat === 'number' && typeof body.location.lon === 'number'
      ? { lat: body.location.lat, lon: body.location.lon }
      : null;
  const result = await sendCheckin(c.env, c.get('userId'), {
    location,
    tzOffsetMinutes: typeof body.tzOffsetMinutes === 'number' ? body.tzOffsetMinutes : null,
  });
  return c.json(result, 200);
});

userRoutes.post('/guardian-enabled', async (c) => {
  if (await lockedDuringAlert(c)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
  await setGuardianEnabled(c.env, c.get('userId'), body.enabled === true);
  return c.json({ ok: true, enabled: body.enabled === true }, 200);
});



/**
 * Brief 37 §E / Brief 40 §E — THE OWNER DESTROYS HER OWN RECORDINGS.
 *
 * DRY RUN BY DEFAULT; `{confirm:true}` deletes. Session-authenticated, and the event must belong
 * to the calling account — the event id in the path is a lookup key, not an authorization.
 *
 * Deletes capture chunks from MEDIA only. The sealed manifest in the vault is locked for 1096
 * days and is never touched; the chain records survive too, so what remains is a provable record
 * that an incident occurred and that its content was destroyed ON CONSENT rather than lost or
 * tampered with. `verifyChain` then reports PURGED_BY_CONSENT.
 *
 * Refused while the event is active: mid-alert, "delete my recordings" is the aggressor's button,
 * and consent under duress is not consent.
 */
userRoutes.post('/events/:id/purge-capture', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ confirm?: boolean; restorePoint?: string }>().catch(() => ({}) as { confirm?: boolean; restorePoint?: string });
  const user = await getUserById(c.env, userId);
  const result = await purgeCaptureOnConsent(c.env, {
    eventId: c.req.param('id'),
    userId,
    userHash: (user as { userHash?: string } | null)?.userHash ?? null,
    confirm: body.confirm === true,
    restorePoint: body.restorePoint ?? null,
  });
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'not_owner' ? 403 : 409;
    return c.json({ error: result.reason, ...result }, status);
  }
  return c.json(result, 200);
});


/**
 * Brief 2 Fix A §A — DEVICE PROVISIONING, ON THE IDENTITY BOUNDARY.
 *
 * Deliberately here and not in the event Durable Object (§E4): the DO validates event-scoped
 * signed requests and does not mint, store, rotate or revoke identity. Registration is bound to
 * an authenticated session — a passkey login, a magic link, a recovery code, or a Brief 30 Fix A
 * signup capability — so a device can only be added by someone who already holds the account.
 *
 * Multiple devices per account, each independently revocable (§A). §E2: cleared storage means a
 * new keypair and a new registration through the same session, silently, never a dead end.
 */
userRoutes.post('/devices', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ publicKey?: string; label?: string }>().catch(() => ({}) as { publicKey?: string; label?: string });
  const r = await registerDevice(c.env, { userId, publicKey: body.publicKey ?? '', label: body.label ?? null });
  if (!r.ok) return c.json({ error: r.reason ?? 'invalid_public_key' }, 400);
  await audit(c.env, null, 'device.registered', userId, { credentialId: r.id });
  return c.json({ ok: true, credentialId: r.id }, 201);
});

userRoutes.get('/devices', async (c) => c.json({ devices: await listDevices(c.env, c.get('userId')) }, 200));

/**
 * §D — revocation is immediate and audited. It does NOT invalidate historical chain records this
 * device signed while it was valid (Brief 39 §C precedent): revoking a lost phone must not
 * retroactively destroy the evidence it legitimately produced, which is the opposite of what a
 * survivor needs from it.
 */
userRoutes.post('/devices/:id/revoke', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const done = await revokeDevice(c.env, { userId, credentialId: c.req.param('id'), reason: body.reason ?? null });
  if (!done) return c.json({ error: 'not_found_or_already_revoked' }, 404);
  await audit(c.env, null, 'device.revoked', userId, { credentialId: c.req.param('id') });
  return c.json({ ok: true }, 200);
});
