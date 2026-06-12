/**
 * Notification router (W-spine). BLACK BOX is the system; LINE/SMS/email/push
 * are interchangeable channels. The router loads a contact's reach endpoints in
 * priority order and tries each until one accepts the message — so a contact
 * without LINE is still reachable, and adding a channel never touches the call
 * sites. Building a new channel = implement NotificationChannel + add it to the
 * factory below.
 */

import { audit } from '../lib/audit';
import { getContactEndpoints } from '../lib/contacts';
import { recordDelivery } from '../lib/delivery';
import type { Env } from '../types';
import { LineChannel } from './line';
import { SendGridEmailChannel } from './sendgrid-email';
import { TwilioSmsChannel, twilioConfig } from './twilio-sms';
import { StubChannel } from './stub';
import type {
  ActivationAlertPayload,
  ChannelName,
  ClassificationUpdatePayload,
  ClosureConfirmationPayload,
  ClosureRequestPayload,
  DuressAlertPayload,
  EscalationAlertPayload,
  NotificationChannel,
  StandDownConfirmationPayload,
} from './types';

export type ChannelMessage =
  | { kind: 'activation'; eventId: string; payload: ActivationAlertPayload }
  | { kind: 'escalation'; eventId: string; payload: EscalationAlertPayload }
  | { kind: 'closure'; eventId: string; payload: ClosureRequestPayload }
  | { kind: 'duress'; eventId: string; payload: DuressAlertPayload }
  | { kind: 'closureConfirmation'; eventId: string; payload: ClosureConfirmationPayload }
  | { kind: 'standDownConfirmation'; eventId: string; payload: StandDownConfirmationPayload }
  | { kind: 'classificationUpdate'; eventId: string; payload: ClassificationUpdatePayload };

export interface DispatchResult {
  delivered: boolean;
  channel: ChannelName | null;
}

/** Build the channel implementation for an endpoint, or null if unconfigured. */
function createChannel(
  env: Env,
  channel: ChannelName,
  identifier: string,
): NotificationChannel | null {
  switch (channel) {
    case 'line':
      return env.LINE_CHANNEL_ACCESS_TOKEN
        ? new LineChannel(env.LINE_CHANNEL_ACCESS_TOKEN, identifier)
        : null;
    case 'email':
      return env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL
        ? new SendGridEmailChannel(env, identifier)
        : null;
    case 'sms':
      return twilioConfig(env) ? new TwilioSmsChannel(env, identifier) : new StubChannel('sms');
    case 'push':
    case 'telegram':
      return new StubChannel(channel);
    default:
      return null;
  }
}

/**
 * Default channel preference (Fix Brief 3 R4 + Twilio): SMS is the default
 * primary, email is the fallback. This is a TIE-BREAKER only — a recipient's
 * explicit per-endpoint priority always wins, so any recipient can be routed
 * differently. No channel is hardcoded as the spine.
 */
const CHANNEL_RANK: Record<string, number> = { sms: 0, line: 1, push: 2, telegram: 3, email: 9 };

function channelRank(channel: string): number {
  return CHANNEL_RANK[channel] ?? 5;
}

/** Invoke the channel method matching the message kind. */
function sendMessage(channel: NotificationChannel, message: ChannelMessage): Promise<boolean> {
  switch (message.kind) {
    case 'activation':
      return channel.pushActivationAlert(message.eventId, message.payload);
    case 'escalation':
      return channel.pushEscalation(message.eventId, message.payload);
    case 'closure':
      return channel.pushClosureRequest(message.eventId, message.payload);
    case 'duress':
      return channel.pushDuressAlert(message.eventId, message.payload);
    case 'closureConfirmation':
      return channel.pushClosureConfirmation(message.eventId, message.payload);
    case 'standDownConfirmation':
      return channel.pushStandDownConfirmation(message.eventId, message.payload);
    case 'classificationUpdate':
      return channel.pushClassificationUpdate(message.eventId, message.payload);
    default:
      return Promise.resolve(false);
  }
}

/**
 * Try the contact's endpoints in priority order until one delivers. Audits the
 * outcome per endpoint (`notification_delivered_<channel>` /
 * `notification_failed_<channel>`) and `all_channels_failed` if none succeed.
 */
export async function dispatch(
  env: Env,
  contactId: string,
  message: ChannelMessage,
  actorHash: string | null = null,
): Promise<DispatchResult> {
  const endpoints = await getContactEndpoints(env, contactId);
  if (endpoints.length === 0) {
    await audit(env, message.eventId, 'all_channels_failed', actorHash, { reason: 'no_endpoints' });
    return { delivered: false, channel: null };
  }
  // Order by the recipient's explicit priority first; break ties by the default
  // channel preference (SMS primary, email fallback). Channel-agnostic spine.
  endpoints.sort((a, b) => a.priority - b.priority || channelRank(a.channel) - channelRank(b.channel));

  for (const endpoint of endpoints) {
    const channelName = endpoint.channel as ChannelName;
    const channel = createChannel(env, channelName, endpoint.channelIdentifier);
    if (!channel) {
      await audit(env, message.eventId, `notification_failed_${channelName}`, actorHash, {
        reason: 'unconfigured',
      });
      await recordDelivery(env, {
        eventId: message.eventId,
        messageKind: message.kind,
        channel: channelName,
        status: 'skipped',
        detail: 'unconfigured',
      });
      continue;
    }
    const ok = await sendMessage(channel, message);
    // Per-channel delivery record (Fix Brief 1 #5) — delivery is observable in
    // D1, not guessed. providerMessageId links back to the provider's own logs.
    await recordDelivery(env, {
      eventId: message.eventId,
      messageKind: message.kind,
      channel: channelName,
      status: ok ? 'delivered' : 'failed',
      providerMessageId: channel.lastProviderMessageId ?? null,
    });
    if (ok) {
      await audit(env, message.eventId, `notification_delivered_${channelName}`, actorHash, null);
      return { delivered: true, channel: channelName };
    }
    await audit(env, message.eventId, `notification_failed_${channelName}`, actorHash, null);
  }

  await audit(env, message.eventId, 'all_channels_failed', actorHash, null);
  return { delivered: false, channel: null };
}
