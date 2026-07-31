/**
 * The deploy canary (Brief 35 §C/§D) — a full round trip that proves the alert path
 * EXISTS on the origin just published, without creating a real emergency record or
 * contacting a real person.
 *
 * WHY IT HAD TO BE BUILT. Deploy currency checked that the PWA and the Worker reported
 * the same build id. That says both halves came from one commit; it says nothing about
 * whether the client can reach the server. A build with an empty API origin — which is
 * what any machine without the gitignored `.env` produced — satisfied currency
 * perfectly while having no alert path at all: activation started local capture, the
 * screen showed an active alert, and no event was created, nobody was notified, and no
 * evidence left the device. The only thing that can disprove that is a transaction that
 * actually completes.
 *
 * THE DANGEROUS PART, NAMED. Proving delivery end-to-end would mean messaging someone.
 * So the canary must NOT deliver — which means introducing a code path whose entire
 * purpose is to not deliver. That is the most hazardous kind of code in this product:
 * Brief 31 refused a test-mode flag for exactly this reason, because a flag set wrongly
 * is one UPDATE away from silently swallowing a real survivor's alert.
 *
 * SO SUPPRESSION IS NOT A FLAG YOU CAN SET. It requires all of:
 *
 *   1. `events.isTest = 1`, which is DERIVED server-side at event creation from the
 *      owning account and is never read from a request body, header or query. A client
 *      asserting `isTest` changes nothing (proved by the §D regression guard).
 *   2. the event's owner still being a canary account at DISPATCH time — re-derived
 *      from `users.isCanary`, not trusted from the event row.
 *   3. `users.isCanary` itself being set only by the ADMIN-gated provisioning route
 *      below, on an account whose address is RFC 2606 reserved and therefore provably
 *      undeliverable anyway (Brief 31's rule still holds underneath this one).
 *
 * Condition 2 is what makes the whole thing fail SAFE. If `isTest` ever appears on a
 * real account — a bad migration, a stray UPDATE, a bug — the alert DISPATCHES NORMALLY
 * and the mismatch is raised as an alertable operator condition. The failure costs a
 * test run. It cannot cost a life.
 */

import type { Env } from '../types';
import { audit } from './audit';
import { isReservedDestination, isReservedEmail, isReservedPhone } from '../channels/reserved';

/**
 * The canary identity. `.test` is an RFC 2606 §2 permanently-reserved TLD: it can never
 * be registered, so this address is provably incapable of receiving mail from anyone.
 * Deliberately the same value in every environment — staging and production have
 * severed databases, so one deterministic identity means the same account per
 * environment and no per-environment secret to get wrong.
 */
export const CANARY_EMAIL = 'canary@blackbox.test';
export const CANARY_NAME = 'Deploy Canary';

/**
 * The canary's recipient. Both endpoints are in reserved ranges, so even if every other
 * guard failed, the provider boundary (Brief 31) still refuses to spend a real send.
 *
 * The phone is NPA-555-01XX — the reserved fictional block is the EXCHANGE `555` plus
 * line `01XX`, not the area code. `+1 555 010 0199` looks reserved and is not: it parses
 * as area code 555, exchange 010, and `isReservedPhone` rejects it. The assertion in
 * `provisionCanary` caught exactly that mistake, which is why it is an assertion and not
 * a comment.
 */
export const CANARY_CONTACT_EMAIL = 'canary-contact@example.com';
export const CANARY_CONTACT_PHONE = '+14155550199';

/** Delivery-record status/reason for a suppressed canary send. Distinct from Brief 31's
 *  `suppressed`/`reserved_address_not_deliverable`, because the REASON differs and a
 *  delivery log that blurs the two cannot answer "why did nothing arrive?". */
export const SUPPRESSED_TEST_STATUS = 'suppressed_test';
export const SUPPRESSED_TEST_REASON = 'canary_event_not_dispatched';

/** How long a canary event may live before the TTL sweep closes and purges it. The
 *  explicit purge at the end of a run is the primary path; this is the backstop for a
 *  run that dies halfway (§C: "TTL expiry plus explicit purge"). */
export const CANARY_TTL_MS = 15 * 60 * 1000;

/**
 * Is this account a canary? The ONLY reader of `users.isCanary`. Returns false for a
 * null userId, so a tokenless (covert) trigger — which has no account at all — can
 * never be mistaken for a test.
 */
export async function isCanaryUser(env: Env, userId: string | null): Promise<boolean> {
  if (!userId) {
    return false;
  }
  const row = await env.DB.prepare('SELECT isCanary FROM users WHERE id = ?')
    .bind(userId)
    .first<{ isCanary: number }>();
  return Number(row?.isCanary ?? 0) === 1;
}

export interface SuppressionDecision {
  /** True ONLY when the event is flagged AND its owner is still a canary account. */
  suppress: boolean;
  /** True when the event row carries the flag but the owner is NOT a canary account —
   *  the alertable operator condition (§D). The alert still dispatches. */
  mismatch: boolean;
}

/**
 * THE SUPPRESSION PREDICATE — the single decision point, called once per dispatch.
 *
 * Keyed entirely on server-derived state: the event's own `isTest` column (stamped from
 * the account at creation, never from a request) AND the owner's current `isCanary`.
 * Both must hold. Requiring the second is what makes a wrongly-set flag harmless: it
 * dispatches, and it complains.
 *
 * Note the default on every uncertain path is `suppress: false`. A missing event row, a
 * deleted owner, a NULL userId — all of them deliver. This function can only ever
 * decide to stay quiet about an event it can positively prove is a canary's.
 */
export async function suppressionFor(env: Env, eventId: string): Promise<SuppressionDecision> {
  const row = await env.DB.prepare('SELECT isTest, userId FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ isTest: number; userId: string | null }>();
  if (!row || Number(row.isTest ?? 0) !== 1) {
    return { suppress: false, mismatch: false };
  }
  const ownerIsCanary = await isCanaryUser(env, row.userId);
  return { suppress: ownerIsCanary, mismatch: !ownerIsCanary };
}

export interface CanaryAccount {
  userId: string;
  email: string;
  contactId: string;
}

/**
 * Provision (or re-provision, idempotently) this environment's canary account and its
 * reserved-address contact. ADMIN-gated at the route; this is the ONLY writer of
 * `users.isCanary` in the entire Worker.
 *
 * The account is a real account in every respect except its address and its flag — it
 * signs in, opens events and runs the cascade exactly like a survivor's would, which is
 * the point: a canary that took a special code path would prove that special code path
 * works and nothing else.
 */
export async function provisionCanary(env: Env): Promise<CanaryAccount> {
  // Both addresses are reserved by construction; assert it rather than assume it, so a
  // future edit to the constants above cannot quietly point the canary at a real inbox.
  if (!isReservedEmail(CANARY_EMAIL) || !isReservedEmail(CANARY_CONTACT_EMAIL) || !isReservedPhone(CANARY_CONTACT_PHONE)) {
    throw new Error('canary addresses must be RFC 2606 reserved — refusing to provision');
  }

  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(CANARY_EMAIL)
    .first<{ id: string }>();

  let userId = existing?.id ?? null;
  if (!userId) {
    userId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, name, phone, email, phoneVerifiedAt, emailVerifiedAt, displayMode, regionId, lockCodeHash, duressCodeHash, passwordHash, nationality, cascadeIntervalSeconds, createdAt, updatedAt, isCanary) VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, 10, ?, ?, 1)',
    )
      .bind(userId, CANARY_NAME, CANARY_EMAIL, 'jp', now, now)
      .run();
  } else {
    // Re-assert the flag every time. If anything ever cleared it, the canary's events
    // would start DISPATCHING for real — to reserved addresses, so still undeliverable,
    // but the gate would stop proving what it claims to prove.
    await env.DB.prepare('UPDATE users SET isCanary = 1, updatedAt = ? WHERE id = ?')
      .bind(now, userId)
      .run();
  }

  // One recipient, both channels reserved, consent `confirmed` so the consent gate
  // (Contact Consent §4) does not filter it out when that gate is armed.
  let contact = await env.DB.prepare("SELECT id FROM contacts WHERE userId = ? AND role = 'contact' LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
  if (!contact) {
    const contactId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO contacts (id, userHash, userId, displayName, contactName, role, priority, status, statusUpdatedAt, createdAt) VALUES (?, NULL, ?, ?, ?, 'contact', 1, 'confirmed', ?, ?)",
    )
      .bind(contactId, userId, 'Canary Contact', 'Canary Contact', now, now)
      .run();
    contact = { id: contactId };
  } else {
    await env.DB.prepare("UPDATE contacts SET status = 'confirmed', statusUpdatedAt = ? WHERE id = ?")
      .bind(now, contact.id)
      .run();
  }

  // Replace endpoints wholesale so a re-provision converges on exactly these two.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contact_endpoints WHERE contactId = ?').bind(contact.id),
    env.DB.prepare(
      'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).bind(crypto.randomUUID(), contact.id, 'sms', CANARY_CONTACT_PHONE, now, now),
    env.DB.prepare(
      'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 2, ?, ?)',
    ).bind(crypto.randomUUID(), contact.id, 'email', CANARY_CONTACT_EMAIL, now, now),
  ]);

  // §G — refuse to hand back a canary that could reach a real person. Checked AFTER the
  // endpoints are written, so it validates what is actually stored rather than intent.
  await assertCanaryContactsReserved(env);

  return { userId, email: CANARY_EMAIL, contactId: contact.id };
}

/**
 * Brief 36 §G — a canary account may hold ONLY reserved-range contacts, and this is
 * checked at STARTUP rather than at dispatch.
 *
 * Brief 35's two-condition suppression was tight against a stray `isTest` and not against a
 * stray `isCanary`: promote a real account and its alerts become suppressible. 0047 makes
 * `isCanary` immutable in the database so that promotion cannot happen quietly. This closes
 * the same gap from the other side — even if an account somehow became a canary, it could
 * only ever suppress messages to destinations that are provably incapable of receiving
 * anything. The unsafe state stops being improbable and becomes unrepresentable.
 *
 * Checked where the deploy gate will actually see it (provision + status), so a violation
 * FAILS THE DEPLOY instead of being discovered when a real alert goes quiet.
 */
export async function findRoutableCanaryContacts(
  env: Env,
): Promise<Array<{ userId: string; channel: string; identifier: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT c.userId AS userId, ep.channel AS channel, ep.channelIdentifier AS identifier
       FROM users u JOIN contacts c ON c.userId = u.id
       JOIN contact_endpoints ep ON ep.contactId = c.id
      WHERE u.isCanary = 1`,
  ).all<{ userId: string; channel: string; identifier: string }>();
  return (results ?? []).filter((r) => !isReservedDestination(r.channel, r.identifier));
}

/**
 * The mirror of `canary_flag_on_non_canary_account` (§G). Error level, because a canary
 * holding a routable contact means the deploy gate could message a real person.
 */
export async function assertCanaryContactsReserved(env: Env): Promise<void> {
  const routable = await findRoutableCanaryContacts(env);
  if (routable.length === 0) {
    return;
  }
  for (const r of routable) {
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'routable_contact_on_canary_account',
        message: 'a canary account holds a contact that can actually receive messages',
        userId: r.userId,
        channel: r.channel,
      }),
    );
    await audit(env, null, 'canary.routable_contact', null, { userId: r.userId, channel: r.channel });
  }
  throw new Error(
    `canary account holds ${routable.length} routable contact(s) on: ${routable
      .map((r) => r.channel)
      .join(', ')} — refusing to proceed (Brief 36 §G)`,
  );
}

export interface PurgeResult {
  events: number;
  chunks: number;
  r2Deleted: number;
  /** Canary events still present after the purge. The gate requires 0 (§C). */
  remaining: number;
  purged: boolean;
}

/**
 * Purge canary events — the bytes first, then every row keyed to them. Same table list
 * and same order as account deletion (lib/users.ts), because a purge that misses a
 * table leaves canary rows in the aggregate the isolation filters were meant to keep
 * them out of.
 *
 * `olderThanMs` scopes the TTL sweep; omitted, it purges every canary event (the
 * explicit end-of-run purge). The canary ACCOUNT survives both — it is provisioned per
 * environment and re-used, and deleting it would just make the next run recreate it.
 */
export async function purgeCanaryEvents(env: Env, opts: { olderThanMs?: number } = {}): Promise<PurgeResult> {
  const cutoff = opts.olderThanMs == null ? null : Date.now() - opts.olderThanMs;
  const scope = cutoff == null ? '' : ' AND createdAt < ?';
  const binds = cutoff == null ? [] : [cutoff];

  const { results: eventRows } = await env.DB.prepare(
    `SELECT id FROM events WHERE isTest = 1${scope}`,
  )
    .bind(...binds)
    .all<{ id: string }>();
  const eventIds = (eventRows ?? []).map((r) => r.id);
  if (eventIds.length === 0) {
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE isTest = 1').first<{ n: number }>();
    return { events: 0, chunks: 0, r2Deleted: 0, remaining: Number(left?.n ?? 0), purged: true };
  }
  const marks = eventIds.map(() => '?').join(', ');

  const { results: chunkRows } = await env.DB.prepare(
    `SELECT r2Key FROM chunks_index WHERE eventId IN (${marks})`,
  )
    .bind(...eventIds)
    .all<{ r2Key: string }>();
  const r2Keys = (chunkRows ?? []).map((r) => r.r2Key);

  // 1. The BYTES first — this is the only moment they can still be named.
  let r2Deleted = 0;
  if (env.MEDIA && r2Keys.length > 0) {
    for (let i = 0; i < r2Keys.length; i += 1000) {
      const batch = r2Keys.slice(i, i + 1000);
      await env.MEDIA.delete(batch);
      r2Deleted += batch.length;
    }
  }

  const byEvent = (table: string) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE eventId IN (${marks})`).bind(...eventIds);

  await env.DB.batch([
    byEvent('chunks_index'),
    byEvent('locations_index'),
    byEvent('transcripts_index'),
    byEvent('classifications_index'),
    byEvent('closure_reports'),
    byEvent('event_origin'),
    byEvent('integrity_records'),
    byEvent('integrity_heads'),
    byEvent('delivery_records'),
    byEvent('wrapped_keys'),
    byEvent('plaintext_commitments'),
    byEvent('custody_transfers'),
    byEvent('vault_objects'),
    byEvent('investigations'),
    byEvent('audit_log'),
    env.DB.prepare(`DELETE FROM events WHERE id IN (${marks})`).bind(...eventIds),
  ]);

  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE isTest = 1').first<{ n: number }>();
  const remaining = Number(left?.n ?? 0);
  return {
    events: eventIds.length,
    chunks: r2Keys.length,
    r2Deleted,
    remaining,
    // The explicit purge must leave nothing; a TTL sweep legitimately leaves younger rows.
    purged: cutoff == null ? remaining === 0 : true,
  };
}

/**
 * TTL backstop, run from the cron. A canary run that dies between opening the event and
 * purging it must not leave an active event emitting cascade steps forever — that is
 * the orphaned-event failure this project has already had to fix once, and a test
 * fixture is no excuse to reintroduce it.
 */
export async function sweepExpiredCanaryEvents(env: Env): Promise<PurgeResult> {
  return purgeCanaryEvents(env, { olderThanMs: CANARY_TTL_MS });
}

/**
 * Presence-and-shape report for the deploy gate. NEVER returns a secret's value —
 * only whether it is set and, where shape is meaningful, how long it is. A gate that
 * printed secrets would be a worse problem than the one it checks for.
 */
export function canaryEnvironmentReport(env: Env): Record<string, unknown> {
  const present = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return {
    bindings: {
      DB: !!env.DB,
      MEDIA: !!env.MEDIA,
      VAULT: !!env.VAULT,
      CASCADE_DO: !!env.CASCADE_DO,
      EVENT_CHANNEL: !!env.EVENT_CHANNEL,
    },
    secrets: {
      ADMIN_TOKEN: present(env.ADMIN_TOKEN),
      SESSION_SECRET: present(env.SESSION_SECRET),
      MAGIC_LINK_SECRET: present(env.MAGIC_LINK_SECRET),
      INTEGRITY_SIGNING_KEY: present(env.INTEGRITY_SIGNING_KEY),
      REPORT_SIGNING_KEY: present(env.REPORT_SIGNING_KEY),
      SENDGRID_API_KEY: present(env.SENDGRID_API_KEY),
      LINE_CHANNEL_ACCESS_TOKEN: present(env.LINE_CHANNEL_ACCESS_TOKEN),
      TWILIO_AUTH_TOKEN: present(env.TWILIO_AUTH_TOKEN),
    },
    vars: {
      WORKER_BUILD: env.WORKER_BUILD ?? null,
      WORKER_ORIGIN: env.WORKER_ORIGIN ?? null,
      ENVELOPE_ENCRYPTION_ENABLED: env.ENVELOPE_ENCRYPTION_ENABLED ?? null,
    },
  };
}

/**
 * Record a suppression, loudly (§D). Every suppressed dispatch names the event and the
 * reason, and a MISMATCH — a flagged event on a non-canary account — logs at error level
 * and writes an audit row, because that combination should be impossible and means
 * something has written to a column nothing user-facing can reach.
 */
export async function logSuppression(
  env: Env,
  eventId: string,
  decision: SuppressionDecision,
  channel: string,
): Promise<void> {
  if (decision.mismatch) {
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'canary_flag_on_non_canary_account',
        message: 'event.isTest set on an account that is NOT a canary — alert DISPATCHED normally',
        eventId,
        channel,
      }),
    );
    await audit(env, eventId, 'canary.flag_mismatch', null, { channel, dispatched: true });
    return;
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'dispatch_suppressed',
      reason: SUPPRESSED_TEST_REASON,
      eventId,
      channel,
    }),
  );
}
