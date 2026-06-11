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

import { dispatch } from '../channels/router';
import type { ChannelName } from '../channels/types';
import type { Env } from '../types';
import { audit } from './audit';
import { getContact } from './contacts';
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
  userHash: string,
  workerOrigin: string,
): Promise<void> {
  const contact = await getContact(env, userHash);
  if (!contact) {
    await audit(env, eventId, 'notification_skipped', userHash, { reason: 'no_contact' });
    return;
  }
  if (!env.MAGIC_LINK_SECRET) {
    await audit(env, eventId, 'notification_skipped', userHash, { reason: 'unconfigured' });
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

  let result = await dispatch(env, contact.id, message, userHash);
  if (!result.delivered) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await dispatch(env, contact.id, message, userHash);
  }
  if (result.delivered && result.channel) {
    await markDelivered(env, eventId, result.channel);
  }
}
