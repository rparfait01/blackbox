/**
 * Activation notification orchestration. Assembles the alert payload (with
 * magic-link dashboard + audio URLs) and hands it to the NotificationRouter,
 * which tries the contact's endpoints in priority order — retrying once after 5s
 * if every endpoint fails. On success it sets `events.notifiedAt` +
 * `events.notifyChannel` to the channel that delivered; that is the
 * "contact notified" step of the acknowledgment loop (user activates → cloud
 * records → contact notified → contact acknowledges → contact responds
 * externally, out of band). The user's phone is never signalled.
 *
 * Runs entirely inside `ctx.waitUntil()` so it never blocks the 201 returned to
 * the PWA, and never changes anything the PWA observes.
 */

import { formatLocal, formatLocalClock, isLinkReissueDue } from '@blackbox/shared';

import { dispatch } from '../channels/router';
import { broadcastEventChange } from '../event-channel';
import type { Env } from '../types';
import { audit } from './audit';
import { getContactForEvent, listCascadeContacts, listReachableContacts } from './contacts';
import { regionToEmergency } from './contact-state';
import { mintMagicToken, MAGIC_LINK_TTL_MS } from './magic-link';

/** Mark when the current coordinator magic-link was (re)minted (UTC ms), so the
 *  reissue cron can detect an expired link on an unresolved event. */
async function markLinkIssued(env: Env, eventId: string): Promise<void> {
  await env.DB.prepare('UPDATE events SET lastLinkIssuedAt = ? WHERE id = ?')
    .bind(Date.now(), eventId)
    .run();
}

async function latestSummary(env: Env, eventId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT summaryText FROM classifications_index WHERE eventId = ? ORDER BY timestamp DESC LIMIT 1',
  )
    .bind(eventId)
    .first<{ summaryText: string | null }>();
  return row?.summaryText ?? null;
}

async function latestLocation(
  env: Env,
  eventId: string,
): Promise<{ lat: number; lon: number } | null> {
  const row = await env.DB.prepare(
    'SELECT lat, lon FROM locations_index WHERE eventId = ? ORDER BY timestamp DESC LIMIT 1',
  )
    .bind(eventId)
    .first<{ lat: number; lon: number }>();
  return row ? { lat: row.lat, lon: row.lon } : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-account cascade window (ms between steps). Defaults to 10s so the full
 *  primary→secondary→tertiary→guardian→emergency chain lands inside 60s
 *  (T+0/+10/+20/+30/+40). */
const DEFAULT_CASCADE_INTERVAL_SECONDS = 10;
async function cascadeIntervalMs(env: Env, userId: string | null): Promise<number> {
  if (!userId) {
    return DEFAULT_CASCADE_INTERVAL_SECONDS * 1000;
  }
  const row = await env.DB.prepare('SELECT cascadeIntervalSeconds FROM users WHERE id = ?')
    .bind(userId)
    .first<{ cascadeIntervalSeconds: number | null }>();
  return Math.max(1, row?.cascadeIntervalSeconds ?? DEFAULT_CASCADE_INTERVAL_SECONDS) * 1000;
}

/**
 * Atomically claim cascade step `fromStep` → `fromStep + 1`. Only the writer that
 * advances notifies that step, so the in-request stagger and the cron backstop
 * never double-notify. Fails if a coordinator was claimed or the event closed —
 * that is how the cascade HALTS.
 */
async function advanceStep(env: Env, eventId: string, fromStep: number): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE events SET cascadeStep = ? WHERE id = ? AND cascadeStep = ? AND status = 'active' AND coordinatorClaimedAt IS NULL",
  )
    .bind(fromStep + 1, eventId, fromStep)
    .run();
  return r.meta.changes === 1;
}

interface ActivationCtx {
  dashboardUrl: string;
  summaryUrl: string;
  audioUrl: string;
  location: { lat: number; lon: number } | null;
  threatSummary: string | null;
  /** Brief 33 Fix B §D — video named in the alert only on evidence a chunk actually arrived. */
  hasVideo: boolean;
  /** Region-resolved emergency numbers (null when region unknown — the message
   *  then falls back to the JP pilot default). Brief 12 P3. */
  emergency: { police: string; ambulance: string } | null;
}

async function activationCtx(
  env: Env,
  eventId: string,
  workerOrigin: string,
  userId: string | null,
): Promise<ActivationCtx> {
  const token = await mintMagicToken(env.MAGIC_LINK_SECRET as string, eventId);
  let emergency: { police: string; ambulance: string } | null = null;
  if (userId) {
    const user = await env.DB.prepare('SELECT regionId FROM users WHERE id = ?')
      .bind(userId)
      .first<{ regionId: string | null }>();
    emergency = regionToEmergency(user?.regionId ?? null);
  }
  // A fresh coordinator link was just minted — record it so the reissue cron can
  // tell when it later expires on an unresolved event.
  await markLinkIssued(env, eventId);
  return {
    dashboardUrl: `${workerOrigin}/c/${eventId}?t=${token}`,
    // §5: the CAD-ready structured summary for the emergency-services escalation
    // path (direct share gets the live dashboard above).
    summaryUrl: `${workerOrigin}/v1/c/${eventId}/dispatch-summary?t=${token}`,
    audioUrl: `${workerOrigin}/v1/c/${eventId}/audio/latest?t=${token}`,
    location: await latestLocation(env, eventId),
    threatSummary: await latestSummary(env, eventId),
    // Brief 33 Fix B §D — video is named in the alert ONLY on evidence the server holds: a chunk
    // that actually arrived with a video mimeType. Not a device capability, not an intention.
    // At activation, before any chunk has landed, this is false and the message truthfully reads
    // "Live audio + location active" — the subset we can stand behind.
    hasVideo: await hasVideoChunk(env, eventId),
    emergency,
  };
}

/**
 * Has a VIDEO chunk actually arrived for this event?
 *
 * Positive evidence only. Any failure answers `false`, because the failure direction here is not
 * symmetric: under-claiming costs a responder nothing they cannot see for themselves on the
 * dashboard, and over-claiming tells them the system lies at the moment they most need to trust
 * it. If Brief 50 finds video unavailable on a platform this needs no change — no video chunks
 * arrive, so no video is claimed.
 */
async function hasVideoChunk(env: Env, eventId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS n FROM chunks_index WHERE eventId = ? AND mimeType LIKE 'video/%' LIMIT 1",
    )
      .bind(eventId)
      .first<{ n: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Which mechanism actually fired a cascade step. Four drivers can advance the chain,
 * and they are NOT interchangeable when judging health:
 *
 *   alarm     — the Durable Object alarm. The precise, intended driver (Brief 17).
 *   stagger   — the in-request waitUntil stagger. Fine for early steps; reclaimed
 *               ~35s, so it cannot be relied on for the tail.
 *   heartbeat — a device heartbeat opportunistically advanced a due step.
 *   cron      — the 1-minute backstop caught a step the others missed. The capture
 *               still went out, so this is NOT a survivor-facing failure — but it
 *               means the alarm ran late, and that is a real signal worth surfacing
 *               rather than averaging away.
 *
 * Recorded on every cascade_fired row so "did the schedule work?" can be answered
 * exactly, instead of inferred from timestamps that cannot distinguish the drivers.
 */
export type CascadeDriver = 'alarm' | 'cron' | 'stagger' | 'heartbeat';

async function dispatchStep(
  env: Env,
  eventId: string,
  ctx: ActivationCtx,
  contact: { id: string; displayName: string },
  actorHash: string | null,
  step: number,
  via: CascadeDriver,
): Promise<void> {
  // Audit the moment the step FIRES (before the provider round-trip), so the
  // cascade schedule is observable independent of per-channel send latency.
  // `via` records WHICH driver fired it (see CascadeDriver).
  await audit(env, eventId, 'cascade_fired', actorHash, { step, via });
  const result = await dispatch(
    env,
    contact.id,
    {
      kind: 'activation',
      eventId,
      payload: {
        userDisplayName: contact.displayName,
        dashboardUrl: ctx.dashboardUrl,
        summaryUrl: ctx.summaryUrl,
        audioUrl: ctx.audioUrl,
        location: ctx.location,
        threatSummary: ctx.threatSummary,
        hasVideo: ctx.hasVideo,
        emergency: ctx.emergency,
      },
    },
    actorHash,
  );
  if (result.delivered && result.channel) {
    // notifiedAt marks the FIRST delivery only.
    await env.DB.prepare(
      'UPDATE events SET notifiedAt = ?, notifyChannel = ? WHERE id = ? AND notifiedAt IS NULL',
    )
      .bind(Date.now(), result.channel, eventId)
      .run();
  } else {
    // Brief 23 §2: this cascade step reached NOBODY — every channel for this
    // recipient failed (e.g. sendgrid_401 "Maximum credits exceeded"). Fail LOUD:
    // record it distinctly and push it to the coordinator dashboard, so a
    // zero-delivery is never a swallowed retry-log line. dispatch() already audited
    // the per-channel reasons; this is the event-level "reached no one" signal.
    await audit(env, eventId, 'cascade_step_undelivered', actorHash, { step });
    await broadcastEventChange(env, eventId, 'delivery_failed');
  }
}

/**
 * Sequential contact cascade (Brief 11). On activation, notify contacts in
 * PRIORITY ORDER, staggered (default 15s): primary → secondary → tertiary →
 * guardian. The first to open the dashboard claims coordinator; the cascade then
 * HALTS (advanceStep fails once coordinatorClaimedAt is set). Recipients are
 * resolved FRESH so a newly added contact is always included. Runs inside
 * ctx.waitUntil(); the 1-min cron (advanceCascades) backstops a worker that dies
 * mid-stagger and fires the emergency-services fallback.
 */
/**
 * How far past activation the IN-REQUEST stagger chain is allowed to reach. The runtime
 * reclaims a request's waitUntil at roughly 30s; this leaves headroom for the dispatch and
 * its audit writes to finish inside a context that is still alive. Steps due later belong
 * to the Durable Object alarm, which fires at the exact window and does not inherit this
 * request's lifetime. Deliberately a stated number rather than "as long as it lasts".
 */
export const STAGGER_BUDGET_MS = 20_000;

export async function notifyActivation(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<void> {
  const event = await env.DB.prepare('SELECT userId, userHash, createdAt FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null; createdAt: number }>();
  if (!event) {
    return;
  }
  if (!env.MAGIC_LINK_SECRET) {
    await audit(env, eventId, 'notification_skipped', event.userHash, { reason: 'unconfigured' });
    return;
  }
  const contacts = await listCascadeContacts(env, event);
  if (contacts.length === 0) {
    await audit(env, eventId, 'notification_skipped', event.userHash, { reason: 'no_contact' });
    return;
  }
  const interval = await cascadeIntervalMs(env, event.userId);
  const ctx = await activationCtx(env, eventId, workerOrigin, event.userId);

  // Arm the Durable Object scheduler so every step (incl. emergency at +interval*N)
  // fires at its exact window even if this in-request stagger's waitUntil is
  // reclaimed. Idempotent with the loop below via the atomic per-step claim.
  await armCascadeSchedule(env, eventId, workerOrigin);

  for (let step = 0; step < contacts.length; step += 1) {
    // STOP BEFORE THE CONTEXT DIES (Brief 36 §11 diagnosis).
    //
    // This loop runs inside the activation request's waitUntil, which the runtime
    // reclaims roughly 30s after the response. It used to sleep all the way to
    // T+40s, so the last steps executed on borrowed time and were TRUNCATED
    // MID-SEQUENCE: a real staging trace showed step 3 firing at T+30s, its dispatch
    // completing at T+40.7s, and its `cascade_step_undelivered` audit row never
    // landing — the row after the one that did. Sometimes the truncation hit earlier
    // and even `cascade_fired` was lost, which is what made acceptance check 8 read
    // "expected 5, got 4" at random.
    //
    // Nobody went unnotified — every dispatch and every delivery_record landed. What
    // was lost was the AUDIT TRAIL, which in this product is evidence: the closure
    // report and the coordinator view are built from these rows, so a cascade that
    // silently stops recording itself is a custody defect even when delivery is fine.
    //
    // The fix is not a longer budget — it is not doing late work here at all. The
    // Durable Object alarm is the EXACT driver and is already armed above; the cron
    // is the coarse backstop. So the in-request chain now covers only the steps it
    // can finish honestly, and hands the tail to a driver that is not about to die.
    // Measured from EVENT CREATION, not from "how long is left to wait". The remaining
    // wait shrinks as the loop advances, so a relative test always looks affordable and
    // the chain still walks off the end of its lifetime one step at a time.
    if (step * interval > STAGGER_BUDGET_MS) {
      return; // the DO alarm owns every remaining step, at its exact window
    }
    // Sleep to the step's ABSOLUTE target (createdAt + step*interval) rather than
    // a per-step relative delay — so per-send latency does not compound and
    // guardian/emergency land in their windows (T+0/+10/+20/+30/+40), never drift
    // a few seconds later each step.
    const waitMs = event.createdAt + step * interval - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    if (!(await advanceStep(env, eventId, step))) {
      return; // coordinator claimed / event closed / a tick already advanced — halt
    }
    // A failed or throwing send on ANY step must NEVER stop the later steps — the
    // schedule keeps advancing no matter what (dispatch already records the
    // per-channel failure; this guards an unexpected throw too).
    try {
      await dispatchStep(env, eventId, ctx, contacts[step]!, event.userHash, step, 'stagger');
    } catch (e) {
      await audit(env, eventId, 'cascade_step_error', event.userHash, { step, detail: String(e).slice(0, 160) });
    }
  }
}

/**
 * Advance ONE active event's cascade to whatever step its elapsed time is due —
 * firing every step from the current `cascadeStep` up to `floor(elapsed/interval)`
 * (emergency is the final step, so it fires at its window like any other). Returns
 * silently if the event was claimed / closed / already caught up. Idempotent: the
 * atomic `advanceStep` guarantees each step fires exactly once across the
 * in-request stagger, the heartbeat tick, and the cron — so they never
 * double-notify and a failed step never blocks the next.
 */
export async function advanceEventCascade(
  env: Env,
  ev: { id: string; userId: string | null; userHash: string | null; createdAt: number; cascadeStep: number },
  workerOrigin: string,
  via: CascadeDriver,
  now: number = Date.now(),
): Promise<void> {
  if (!env.MAGIC_LINK_SECRET) {
    return;
  }
  const contacts = await listCascadeContacts(env, { userId: ev.userId, userHash: ev.userHash });
  if (contacts.length === 0) {
    return;
  }
  const intervalSec = (await cascadeIntervalMs(env, ev.userId)) / 1000;
  const elapsed = (now - ev.createdAt) / 1000;
  const dueSteps = Math.min(contacts.length, Math.floor(elapsed / intervalSec) + 1);
  let step = ev.cascadeStep;
  if (step >= dueSteps) {
    return;
  }
  const ctx = await activationCtx(env, ev.id, workerOrigin, ev.userId);
  while (step < dueSteps) {
    if (!(await advanceStep(env, ev.id, step))) {
      break; // claimed / closed / raced with another driver — halt
    }
    try {
      await dispatchStep(env, ev.id, ctx, contacts[step]!, ev.userHash, step, via);
    } catch (e) {
      await audit(env, ev.id, 'cascade_step_error', ev.userHash, { step, detail: String(e).slice(0, 160) });
    }
    step += 1;
  }
}

/**
 * One Durable-Object-driven cascade tick (Brief 17). Fires whatever steps are due
 * for the event right now, then returns the absolute wall-clock time of the NEXT
 * unfired step so the DO can set its next alarm — or null when the chain is
 * exhausted / the event was claimed or closed (the DO then stops). This is the
 * precise timing driver that does NOT depend on the activation waitUntil surviving
 * or a device heartbeat; the in-request stagger + cron remain as backstops.
 */
export async function cascadeTick(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<number | null> {
  const ev = await env.DB.prepare(
    "SELECT id, userId, userHash, createdAt, cascadeStep, status, coordinatorClaimedAt FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{
      id: string;
      userId: string | null;
      userHash: string | null;
      createdAt: number;
      cascadeStep: number;
      status: string;
      coordinatorClaimedAt: number | null;
    }>();
  if (!ev || ev.status !== 'active' || ev.coordinatorClaimedAt != null) {
    return null; // claimed / closed / gone — stop the schedule
  }
  await advanceEventCascade(env, ev, workerOrigin, 'alarm');
  const contacts = await listCascadeContacts(env, { userId: ev.userId, userHash: ev.userHash });
  const fresh = await env.DB.prepare('SELECT cascadeStep FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ cascadeStep: number }>();
  const step = fresh?.cascadeStep ?? ev.cascadeStep;
  if (step >= contacts.length) {
    return null; // every step fired — done
  }
  const interval = await cascadeIntervalMs(env, ev.userId);
  return ev.createdAt + step * interval; // exact time of the next unfired step
}

/**
 * Arm the Durable Object that fires each cascade step at its exact wall-clock
 * window (Brief 17). No-op when the binding is absent (e.g. local dev / a
 * deployment without the DO) — the in-request stagger + heartbeat + cron still
 * drive the cascade, just with coarser tail timing.
 */
export async function armCascadeSchedule(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<void> {
  if (!env.CASCADE_DO) {
    return;
  }
  const stub = env.CASCADE_DO.get(env.CASCADE_DO.idFromName(eventId));
  await stub.fetch('https://cascade-do/arm', {
    method: 'POST',
    body: JSON.stringify({ eventId, workerOrigin }),
  });
}

/**
 * Cron backstop (Brief 11). For every active, UNCLAIMED event, fire any cascade
 * step whose window has elapsed but wasn't notified (e.g. the worker died
 * mid-stagger). The cron is 60s-granular, so it is the coarse safety net; the
 * Durable Object alarm (exact), the in-request stagger, and the per-heartbeat tick
 * provide the tight timing.
 */
export async function advanceCascades(env: Env, workerOrigin: string): Promise<void> {
  if (!env.MAGIC_LINK_SECRET) {
    return;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, userId, userHash, createdAt, cascadeStep FROM events WHERE status = 'active' AND coordinatorClaimedAt IS NULL",
  ).all<{
    id: string;
    userId: string | null;
    userHash: string | null;
    createdAt: number;
    cascadeStep: number;
  }>();
  const now = Date.now();
  for (const ev of results ?? []) {
    try {
      await advanceEventCascade(env, ev, workerOrigin, 'cron', now);
    } catch (e) {
      await audit(env, ev.id, 'cascade_step_error', ev.userHash, { detail: String(e).slice(0, 160) });
    }
  }
}

/**
 * Notify the network that the user has REQUESTED closure (Brief 9 Phase D). The
 * coordinator reviews + secures; this just pings the contacts so they look. A
 * duress (unsat) request sends the duress message ("threat ongoing"), a normal
 * (sat) request sends the closure-review message. Never closes anything.
 */
export async function notifyClosureRequest(
  env: Env,
  eventId: string,
  workerOrigin: string,
  status: 'sat' | 'unsat',
): Promise<void> {
  const event = await env.DB.prepare('SELECT userId, userHash FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null }>();
  if (!event || !env.MAGIC_LINK_SECRET) {
    return;
  }
  const contacts = await listReachableContacts(env, event);
  if (contacts.length === 0) {
    return;
  }
  const token = await mintMagicToken(env.MAGIC_LINK_SECRET, eventId);
  const dashboardUrl = `${workerOrigin}/c/${eventId}?t=${token}`;
  for (const contact of contacts) {
    const message =
      status === 'unsat'
        ? ({ kind: 'duress', eventId, payload: { userDisplayName: contact.displayName, dashboardUrl } } as const)
        : ({ kind: 'closure', eventId, payload: { userDisplayName: contact.displayName, dashboardUrl } } as const);
    await dispatch(env, contact.id, message, event.userHash);
  }
}

/**
 * "Device went dark" escalation (Fix Brief 1 #3). Fired when an active event's
 * heartbeat goes stale (cron) or the client reports itself lost (pagehide
 * beacon). Sets `events.escalatedAt` exactly once so it never re-fires. An
 * interruption ESCALATES — it never closes the event.
 */
export async function notifyEscalation(
  env: Env,
  eventId: string,
  workerOrigin: string,
  reason: 'device_dark' | 'client_lost',
): Promise<void> {
  const event = await env.DB.prepare(
    'SELECT userId, userHash, status, escalatedAt, lastHeartbeatAt, tzOffsetMinutes FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      userId: string | null;
      userHash: string | null;
      status: string;
      escalatedAt: number | null;
      lastHeartbeatAt: number | null;
      tzOffsetMinutes: number | null;
    }>();
  // Never escalate a closed event, and never escalate twice.
  if (!event || event.status !== 'active' || event.escalatedAt != null) {
    return;
  }
  // Claim the escalation atomically: only the writer that flips escalatedAt from
  // NULL proceeds, so concurrent cron + beacon can't double-send.
  const claim = await env.DB.prepare(
    'UPDATE events SET escalatedAt = ? WHERE id = ? AND escalatedAt IS NULL AND status = ?',
  )
    .bind(Date.now(), eventId, 'active')
    .run();
  if (claim.meta.changes === 0) {
    return;
  }

  const actorHash = event.userHash;
  const contact = await getContactForEvent(env, event);
  if (!contact || !env.MAGIC_LINK_SECRET) {
    await audit(env, eventId, 'escalation_skipped', actorHash, {
      reason: contact ? 'unconfigured' : 'no_contact',
    });
    return;
  }
  const token = await mintMagicToken(env.MAGIC_LINK_SECRET, eventId);
  await markLinkIssued(env, eventId);
  const dashboardUrl = `${workerOrigin}/c/${eventId}?t=${token}`;
  const lastSeen = event.lastHeartbeatAt
    ? formatLocalClock(event.lastHeartbeatAt, event.tzOffsetMinutes)
    : null;
  await audit(env, eventId, 'escalation_fired', actorHash, { reason });
  await dispatch(
    env,
    contact.id,
    {
      kind: 'escalation',
      eventId,
      payload: {
        userDisplayName: contact.displayName,
        dashboardUrl,
        reason,
        lastSeen,
        location: await latestLocation(env, eventId),
      },
    },
    actorHash,
  );
}

/**
 * Brief 23 §3 backstop. The coordinator path failed at the fail bound and there is
 * NO guardian to escalate to. Re-notify every reachable contact so coordination
 * does not silently dead-end — the alert must never vanish because a guardian was
 * never configured. The real fix is adding a guardian; this is the loud backstop.
 */
export async function renotifyContactsNoGuardian(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<void> {
  if (!env.MAGIC_LINK_SECRET) {
    return;
  }
  const event = await env.DB.prepare('SELECT userId, userHash, status FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null; status: string }>();
  if (!event || event.status !== 'active') {
    return;
  }
  const contacts = await listReachableContacts(env, event);
  if (contacts.length === 0) {
    await audit(env, eventId, 'renotify_no_recipient', event.userHash, null);
    return;
  }
  const token = await mintMagicToken(env.MAGIC_LINK_SECRET, eventId);
  await markLinkIssued(env, eventId);
  const dashboardUrl = `${workerOrigin}/c/${eventId}?t=${token}`;
  const location = await latestLocation(env, eventId);
  for (const contact of contacts) {
    await dispatch(
      env,
      contact.id,
      {
        kind: 'escalation',
        eventId,
        payload: { userDisplayName: contact.displayName, dashboardUrl, reason: 'client_lost', lastSeen: null, location },
      },
      event.userHash,
    );
  }
  await audit(env, eventId, 'renotified_contacts_no_guardian', event.userHash, { count: contacts.length });
}

/** The account owner's name + email — "triggered by" in a reissue notice. */
async function triggererIdentity(
  env: Env,
  userId: string | null,
): Promise<{ name: string | null; email: string | null }> {
  if (!userId) {
    return { name: null, email: null };
  }
  const u = await env.DB.prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  return { name: u?.name ?? null, email: u?.email ?? null };
}

/**
 * The "contact required to confirm closure" — the coordinator of last resort.
 * Prefers the Guardian (when enabled); falls back to the lowest-priority Contact
 * if there is no usable guardian. Name + reach destination (usually an email).
 */
async function closerIdentity(
  env: Env,
  userId: string | null,
): Promise<{ name: string | null; email: string | null }> {
  if (!userId) {
    return { name: null, email: null };
  }
  const user = await env.DB.prepare('SELECT guardianEnabled FROM users WHERE id = ?')
    .bind(userId)
    .first<{ guardianEnabled: number }>();
  const guardianEnabled = (user?.guardianEnabled ?? 1) === 1;
  const roleFilter = guardianEnabled ? "('contact','guardian')" : "('contact')";
  const row = await env.DB.prepare(
    `SELECT c.contactName AS name, ep.channelIdentifier AS dest
       FROM contacts c LEFT JOIN contact_endpoints ep ON ep.contactId = c.id
      WHERE c.userId = ? AND c.role IN ${roleFilter}
      ORDER BY CASE c.role WHEN 'guardian' THEN 1 ELSE 0 END DESC, c.priority DESC
      LIMIT 1`,
  )
    .bind(userId)
    .first<{ name: string | null; dest: string | null }>();
  return { name: row?.name ?? null, email: row?.dest ?? null };
}

/**
 * Reissue expired coordinator links (the orphaned-event failsafe). For every
 * active, UNRESOLVED event whose coordinator link has been alive longer than the
 * magic-link TTL with no coordinator claimed, mint a FRESH live link and
 * re-notify ALL current recipients with full provenance. The re-notification
 * carries a working link — never a bare FYI — so the path to closure regenerates
 * and never dead-ends. New-party escalation stays bounded (cascade → guardian →
 * emergency); this keeps the last-resort coordinator's link alive indefinitely.
 *
 * Runs from the 1-min cron. Each event is claimed atomically (CAS on
 * lastLinkIssuedAt) so concurrent crons never double-reissue.
 */
/**
 * Brief 33 Fix B §B — reissue ONE event's link, on a coordinator's own request.
 *
 * The self-service path off a spent link. `reissueExpiredLinks` is a cron sweep scoped to links
 * that have EXPIRED; this is a live link that was redeemed in another browser, which is a
 * different condition entirely — the link works, it is simply bound elsewhere.
 *
 * It reuses the one dispatcher and sends to the contacts the cascade already knows. The fresh
 * link is never returned to the caller: this is reachable without credentials by design (whoever
 * calls it has just been refused), and an endpoint that hands a working link to whoever asks
 * would be a larger hole than the address-bar exposure this brief closes.
 */
export async function reissueLinkForEvent(env: Env, eventId: string, workerOrigin: string): Promise<number> {
  if (!env.MAGIC_LINK_SECRET) return 0;
  const ev = await env.DB.prepare(
    "SELECT id, userId, userHash, createdAt, tzOffsetMinutes FROM events WHERE id = ? AND status = 'active'",
  )
    .bind(eventId)
    .first<{ id: string; userId: string | null; userHash: string | null; createdAt: number; tzOffsetMinutes: number | null }>();
  if (!ev) return 0;

  const contacts = await listCascadeContacts(env, { userId: ev.userId, userHash: ev.userHash });
  if (contacts.length === 0) {
    await audit(env, ev.id, 'link_reissue_skipped', ev.userHash, { reason: 'no_contact' });
    return 0;
  }

  const now = Date.now();
  const token = await mintMagicToken(env.MAGIC_LINK_SECRET, ev.id, now);
  const dashboardUrl = `${workerOrigin}/c/${ev.id}?t=${token}`;
  await env.DB.prepare('UPDATE events SET lastLinkIssuedAt = ? WHERE id = ?').bind(now, ev.id).run();
  await audit(env, ev.id, 'link_reissued_on_request', ev.userHash, { recipients: contacts.length });

  for (const contact of contacts) {
    await dispatch(env, contact.id, {
      kind: 'escalation',
      eventId: ev.id,
      payload: {
        userDisplayName: contact.displayName,
        dashboardUrl,
        reason: 'link_reissued',
        location: await latestLocation(env, ev.id),
      },
    });
  }
  return contacts.length;
}

export async function reissueExpiredLinks(env: Env, workerOrigin: string): Promise<void> {
  if (!env.MAGIC_LINK_SECRET) {
    return;
  }
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id, userId, userHash, createdAt, notifiedAt, coordinatorClaimedAt, lastLinkIssuedAt, tzOffsetMinutes FROM events WHERE status = 'active' AND coordinatorClaimedAt IS NULL AND notifiedAt IS NOT NULL AND lastLinkIssuedAt IS NOT NULL",
  ).all<{
    id: string;
    userId: string | null;
    userHash: string | null;
    createdAt: number;
    notifiedAt: number | null;
    coordinatorClaimedAt: number | null;
    lastLinkIssuedAt: number | null;
    tzOffsetMinutes: number | null;
  }>();

  for (const ev of results ?? []) {
    const due = isLinkReissueDue({
      now,
      status: 'active',
      coordinatorClaimedAt: ev.coordinatorClaimedAt,
      notifiedAt: ev.notifiedAt,
      lastLinkIssuedAt: ev.lastLinkIssuedAt,
      ttlMs: MAGIC_LINK_TTL_MS,
    });
    if (!due) {
      continue;
    }
    // Claim atomically: only the writer that advances lastLinkIssuedAt from the
    // exact value it read proceeds, so two crons can't both reissue.
    const claim = await env.DB.prepare(
      "UPDATE events SET lastLinkIssuedAt = ?, linkReissueCount = linkReissueCount + 1 WHERE id = ? AND status = 'active' AND coordinatorClaimedAt IS NULL AND lastLinkIssuedAt = ?",
    )
      .bind(now, ev.id, ev.lastLinkIssuedAt)
      .run();
    if (claim.meta.changes !== 1) {
      continue;
    }

    const contacts = await listReachableContacts(env, { userId: ev.userId, userHash: ev.userHash });
    if (contacts.length === 0) {
      await audit(env, ev.id, 'link_reissue_skipped', ev.userHash, { reason: 'no_contact' });
      continue;
    }
    const token = await mintMagicToken(env.MAGIC_LINK_SECRET, ev.id, now);
    const dashboardUrl = `${workerOrigin}/c/${ev.id}?t=${token}`;
    const triggerer = await triggererIdentity(env, ev.userId);
    const closer = await closerIdentity(env, ev.userId);
    const provenance = {
      triggeredByName: triggerer.name,
      triggeredByEmail: triggerer.email,
      triggeredAt: formatLocal(ev.createdAt, ev.tzOffsetMinutes),
      // The previous link expired one TTL after it was last minted.
      linkExpiredAt: formatLocal((ev.lastLinkIssuedAt ?? now) + MAGIC_LINK_TTL_MS, ev.tzOffsetMinutes),
      notifiedAt: formatLocal(now, ev.tzOffsetMinutes),
      closerName: closer.name,
      closerEmail: closer.email,
    };
    await audit(env, ev.id, 'link_reissued', ev.userHash, { recipients: contacts.length });
    for (const contact of contacts) {
      await dispatch(
        env,
        contact.id,
        {
          kind: 'escalation',
          eventId: ev.id,
          payload: {
            userDisplayName: contact.displayName,
            dashboardUrl,
            reason: 'link_reissued',
            location: await latestLocation(env, ev.id),
            provenance,
          },
        },
        ev.userHash,
      );
    }
  }
}
