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

import { formatLocalClock } from '@blackbox/shared';

import { dispatch } from '../channels/router';
import type { Env } from '../types';
import { audit } from './audit';
import { getContactForEvent, listReachableContacts } from './contacts';
import { regionToEmergency } from './contact-state';
import { mintMagicToken } from './magic-link';

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

/** Per-account cascade window (ms between steps). Defaults to 15s. */
async function cascadeIntervalMs(env: Env, userId: string | null): Promise<number> {
  if (!userId) {
    return 15_000;
  }
  const row = await env.DB.prepare('SELECT cascadeIntervalSeconds FROM users WHERE id = ?')
    .bind(userId)
    .first<{ cascadeIntervalSeconds: number }>();
  return Math.max(1, row?.cascadeIntervalSeconds ?? 15) * 1000;
}

async function emergencyAfterSeconds(env: Env, userId: string | null): Promise<number> {
  if (!userId) {
    return 120;
  }
  const row = await env.DB.prepare('SELECT emergencyAfterSeconds FROM users WHERE id = ?')
    .bind(userId)
    .first<{ emergencyAfterSeconds: number }>();
  return Math.max(30, row?.emergencyAfterSeconds ?? 120);
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
  audioUrl: string;
  location: { lat: number; lon: number } | null;
  threatSummary: string | null;
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
  return {
    dashboardUrl: `${workerOrigin}/c/${eventId}?t=${token}`,
    audioUrl: `${workerOrigin}/v1/c/${eventId}/audio/latest?t=${token}`,
    location: await latestLocation(env, eventId),
    threatSummary: await latestSummary(env, eventId),
    emergency,
  };
}

async function dispatchStep(
  env: Env,
  eventId: string,
  ctx: ActivationCtx,
  contact: { id: string; displayName: string },
  actorHash: string | null,
): Promise<void> {
  const result = await dispatch(
    env,
    contact.id,
    {
      kind: 'activation',
      eventId,
      payload: {
        userDisplayName: contact.displayName,
        dashboardUrl: ctx.dashboardUrl,
        audioUrl: ctx.audioUrl,
        location: ctx.location,
        threatSummary: ctx.threatSummary,
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
export async function notifyActivation(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<void> {
  const event = await env.DB.prepare('SELECT userId, userHash FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null }>();
  if (!event) {
    return;
  }
  if (!env.MAGIC_LINK_SECRET) {
    await audit(env, eventId, 'notification_skipped', event.userHash, { reason: 'unconfigured' });
    return;
  }
  const contacts = await listReachableContacts(env, event);
  if (contacts.length === 0) {
    await audit(env, eventId, 'notification_skipped', event.userHash, { reason: 'no_contact' });
    return;
  }
  const interval = await cascadeIntervalMs(env, event.userId);
  const ctx = await activationCtx(env, eventId, workerOrigin, event.userId);

  for (let step = 0; step < contacts.length; step += 1) {
    if (!(await advanceStep(env, eventId, step))) {
      return; // coordinator claimed / event closed / cron advanced — halt
    }
    await dispatchStep(env, eventId, ctx, contacts[step]!, event.userHash);
    if (step < contacts.length - 1) {
      await sleep(interval);
    }
  }
}

/**
 * Cron backstop + emergency fallback (Brief 11). For each active, UNCLAIMED
 * event: fire any cascade step whose window has elapsed but wasn't notified (e.g.
 * the worker died mid-stagger), then — if the chain is exhausted and no one
 * claimed after emergencyAfterSeconds — fire the emergency-services fallback once.
 */
export async function advanceCascades(env: Env, workerOrigin: string): Promise<void> {
  if (!env.MAGIC_LINK_SECRET) {
    return;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, userId, userHash, createdAt, cascadeStep, emergencyNotifiedAt FROM events WHERE status = 'active' AND coordinatorClaimedAt IS NULL",
  ).all<{
    id: string;
    userId: string | null;
    userHash: string | null;
    createdAt: number;
    cascadeStep: number;
    emergencyNotifiedAt: number | null;
  }>();
  const now = Date.now();
  for (const ev of results ?? []) {
    const contacts = await listReachableContacts(env, { userId: ev.userId, userHash: ev.userHash });
    if (contacts.length === 0) {
      continue;
    }
    const intervalSec = (await cascadeIntervalMs(env, ev.userId)) / 1000;
    const elapsed = (now - ev.createdAt) / 1000;
    const dueSteps = Math.min(contacts.length, Math.floor(elapsed / intervalSec) + 1);
    let step = ev.cascadeStep;
    if (step < dueSteps) {
      const ctx = await activationCtx(env, ev.id, workerOrigin, ev.userId);
      while (step < dueSteps) {
        if (!(await advanceStep(env, ev.id, step))) {
          break; // claimed / closed / raced with the in-request cascade
        }
        await dispatchStep(env, ev.id, ctx, contacts[step]!, ev.userHash);
        step += 1;
      }
    }
    const emergencyAfter = await emergencyAfterSeconds(env, ev.userId);
    if (step >= contacts.length && elapsed >= emergencyAfter && ev.emergencyNotifiedAt == null) {
      const claim = await env.DB.prepare(
        "UPDATE events SET emergencyNotifiedAt = ? WHERE id = ? AND emergencyNotifiedAt IS NULL AND coordinatorClaimedAt IS NULL AND status = 'active'",
      )
        .bind(now, ev.id)
        .run();
      if (claim.meta.changes === 1) {
        // Dispatch to the account's configured emergency target if set (Brief 11
        // emergency-services fallback). The 'emergency' slot is a per-account
        // endpoint (channel + destination) the operator configures — for the
        // pilot/testing it can be a monitored number, NOT live 911.
        const emergency = ev.userId
          ? await env.DB.prepare(
              "SELECT id, displayName FROM contacts WHERE userId = ? AND role = 'emergency' LIMIT 1",
            )
              .bind(ev.userId)
              .first<{ id: string; displayName: string }>()
          : null;
        if (emergency) {
          const ctx = await activationCtx(env, ev.id, workerOrigin, ev.userId);
          await dispatchStep(env, ev.id, ctx, emergency, ev.userHash);
          await audit(env, ev.id, 'emergency_fallback_dispatched', ev.userHash, { reason: 'no_coordinator' });
        } else {
          await audit(env, ev.id, 'emergency_fallback', ev.userHash, { reason: 'no_target' });
        }
      }
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
