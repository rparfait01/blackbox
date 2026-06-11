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
import type { ChannelName } from '../channels/types';
import type { Env } from '../types';
import { audit } from './audit';
import { getContactForEvent } from './contacts';
import { mintMagicToken } from './magic-link';

const RETRY_DELAY_MS = 5000;

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

async function markDelivered(env: Env, eventId: string, channel: ChannelName): Promise<void> {
  await env.DB.prepare('UPDATE events SET notifiedAt = ?, notifyChannel = ? WHERE id = ?')
    .bind(Date.now(), channel, eventId)
    .run();
}

/**
 * Push the activation alert to the event's contact via the router. Designed to
 * be passed to `ctx.waitUntil()`. Safe no-ops (audited) when there is no contact
 * or the magic-link signing key is unconfigured.
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
  const actorHash = event.userHash;
  const contact = await getContactForEvent(env, event);
  if (!contact) {
    await audit(env, eventId, 'notification_skipped', actorHash, { reason: 'no_contact' });
    return;
  }
  if (!env.MAGIC_LINK_SECRET) {
    await audit(env, eventId, 'notification_skipped', actorHash, { reason: 'unconfigured' });
    return;
  }

  const token = await mintMagicToken(env.MAGIC_LINK_SECRET, eventId);
  // The Worker itself serves the contact dashboard at /c/:id.
  const dashboardUrl = `${workerOrigin}/c/${eventId}?t=${token}`;
  const audioUrl = `${workerOrigin}/v1/c/${eventId}/audio/latest?t=${token}`;

  const message = {
    kind: 'activation' as const,
    eventId,
    payload: {
      userDisplayName: contact.displayName,
      dashboardUrl,
      audioUrl,
      location: await latestLocation(env, eventId),
      threatSummary: await latestSummary(env, eventId),
    },
  };

  let result = await dispatch(env, contact.id, message, actorHash);
  if (!result.delivered) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await dispatch(env, contact.id, message, actorHash);
  }
  if (result.delivered && result.channel) {
    await markDelivered(env, eventId, result.channel);
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
