/**
 * Notification router (W-spine). BLACK BOX is the system; LINE/SMS/email/push
 * are interchangeable channels. The router loads a contact's reach endpoints in
 * priority order and tries each until one accepts the message — so a contact
 * without LINE is still reachable, and adding a channel never touches the call
 * sites. Building a new channel = implement NotificationChannel + add it to the
 * factory below.
 */

import { audit } from '../lib/audit';
import {
  SUPPRESSED_TEST_REASON,
  SUPPRESSED_TEST_STATUS,
  logSuppression,
  suppressionFor,
} from '../lib/canary';
import { getContactEndpoints } from '../lib/contacts';
import { recordDelivery } from '../lib/delivery';
import type { Env } from '../types';
import { LineChannel } from './line';
import { SendGridEmailChannel } from './sendgrid-email';
import { TwilioSmsChannel, twilioConfig } from './twilio-sms';
import { StubChannel } from './stub';
import { isReservedDestination, SUPPRESSED_REASON, SUPPRESSED_STATUS } from './reserved';
import type {
  ActivationAlertPayload,
  ChannelName,
  CheckinPayload,
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
  | { kind: 'checkin'; eventId: string; payload: CheckinPayload }
  | { kind: 'closure'; eventId: string; payload: ClosureRequestPayload }
  | { kind: 'duress'; eventId: string; payload: DuressAlertPayload }
  | { kind: 'closureConfirmation'; eventId: string; payload: ClosureConfirmationPayload }
  | { kind: 'standDownConfirmation'; eventId: string; payload: StandDownConfirmationPayload }
  | { kind: 'classificationUpdate'; eventId: string; payload: ClassificationUpdatePayload };

/** One attempt on one channel — the raw material of an honest result. */
export interface DispatchAttempt {
  channel: ChannelName;
  ok: boolean;
  /** The provider's ACTUAL rejection, never a bare "send_failed". */
  reason: string | null;
}

/**
 * The per-recipient truth (§3). Rich enough to say which of the three real
 * outcomes happened, so no caller ever has to guess or hardcode a success string:
 *
 *   delivered on the preferred channel   → delivered: true,  fellBack: false
 *   preferred failed, other one worked   → delivered: true,  fellBack: true
 *   every channel failed                 → delivered: false, channel: null
 *
 * `attempts` carries each channel's real reason, so "could not reach" can always
 * explain itself rather than shrug.
 */
export interface DispatchResult {
  delivered: boolean;
  /** The channel that actually delivered, or null when none did. */
  channel: ChannelName | null;
  /** True when the preferred channel failed and a fallback carried it. */
  fellBack: boolean;
  attempts: DispatchAttempt[];
}

/**
 * Whether a channel can ACTUALLY deliver in this deployment — the single source
 * of truth for "is this channel real?". A channel that would resolve to a stub
 * (or to no implementation) is NOT deliverable, so saving a contact on it must be
 * refused rather than silently accepted and then failing at alert time.
 */
export function isChannelDeliverable(env: Env, channel: string): boolean {
  switch (channel) {
    case 'email':
      // RETIRING (notification brief §1): email is a single-vendor cap (100/day
      // free tier) that has now silently failed twice, so it is on its way out of
      // the ALERT path. It stays deliverable ONLY until Twilio is provisioned and
      // SMS is proven — pulling it first would leave every email-only account
      // un-notifiable with no way to fix it, which is the outcome §1's own
      // migration clause forbids. Flip this to `false` once SMS delivers.
      // (Magic-link mail is a SEPARATE transactional path and is unaffected.)
      return !!(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
    case 'line':
      return !!env.LINE_CHANNEL_ACCESS_TOKEN;
    case 'sms':
      // SMS only delivers with a real Twilio config; otherwise it is a stub.
      // NOT provisioned as of 2026-07-17 — no TWILIO_* secrets exist.
      return !!twilioConfig(env);
    default:
      // push / telegram / whatsapp are stubs — present in the registry, unbuilt.
      return false;
  }
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
    // THE SEAM (§2). WhatsApp is a future channel and drops in HERE — implement
    // NotificationChannel, return it from this case, and make isChannelDeliverable
    // true for it. Nothing else changes: not the dispatcher, not the fallback
    // order, not one call site. That is the whole point of channels being inputs.
    // Deliberately left as a stub — the seam is proven, the channel is unbuilt.
    case 'whatsapp':
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
    case 'checkin':
      return channel.pushCheckin(message.eventId, message.payload);
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
 * THE ONE DISPATCHER (§2). Given a recipient, route the message: try their
 * PREFERRED channel first, automatically fall back to their other channel(s) on
 * failure, and only report "not reached" once every channel they have has failed.
 *
 * Channels are INPUTS here, not systems: `createChannel` is the registry, and the
 * only thing adding WhatsApp (or anything else) requires is a case there plus a
 * ChannelName entry — no new path, no new call site, no rebuild. Every caller
 * (activation cascade, escalation, check-in, closure) already comes through this
 * one function, which is why "SMS delivers, LINE delivers, fallback works" is one
 * behaviour to get right rather than N.
 *
 * Audits per endpoint (`notification_delivered_<channel>` /
 * `notification_failed_<channel>`), and `all_channels_failed` only when the
 * recipient is genuinely unreachable.
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
    return { delivered: false, channel: null, fellBack: false, attempts: [] };
  }

  // Brief 35 §C/§D — THE CANARY SUPPRESSION GATE, and the only one in the product.
  //
  // It is placed here, before any channel is constructed, so no provider is reached by
  // any message kind on any path — activation, escalation, check-in, closure, all of
  // them come through this one function. A suppression that lived in a channel would be
  // N gates that can drift; this is one.
  //
  // READ THE PREDICATE, NOT THE FLAG. `suppressionFor` suppresses only when the event
  // is flagged AND its owner is still a canary account, both re-derived from the server
  // at this moment. A flag on a real account falls through to the normal dispatch below
  // and raises an alertable operator condition instead — the failure mode Brief 31
  // warned about, made harmless by construction rather than by discipline. Everything
  // uncertain (missing row, deleted owner, tokenless event) dispatches.
  const suppression = await suppressionFor(env, message.eventId);
  if (suppression.suppress) {
    const attempts: DispatchAttempt[] = [];
    for (const endpoint of endpoints) {
      const channelName = endpoint.channel as ChannelName;
      await recordDelivery(env, {
        eventId: message.eventId,
        messageKind: message.kind,
        channel: channelName,
        status: SUPPRESSED_TEST_STATUS,
        detail: SUPPRESSED_TEST_REASON,
      });
      await logSuppression(env, message.eventId, suppression, channelName);
      attempts.push({ channel: channelName, ok: false, reason: SUPPRESSED_TEST_REASON });
    }
    await audit(env, message.eventId, 'canary.dispatch_suppressed', actorHash, {
      kind: message.kind,
      channels: attempts.map((a) => a.channel).join(','),
    });
    // NOT delivered — nothing was sent, and a canary run that reported delivery would be
    // proving the opposite of what it exists to prove.
    return { delivered: false, channel: null, fellBack: false, attempts };
  }
  if (suppression.mismatch) {
    // Flagged event, non-canary owner. Dispatches normally (below); this only records
    // that it happened, at error level, because nothing user-facing can set that flag.
    await logSuppression(env, message.eventId, suppression, 'all');
  }
  // Order by the recipient's explicit priority first; break ties by the default
  // channel preference (SMS primary, email fallback). Channel-agnostic spine.
  endpoints.sort((a, b) => a.priority - b.priority || channelRank(a.channel) - channelRank(b.channel));

  const attempts: DispatchAttempt[] = [];
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
      // An unconfigured channel is a real reason this recipient wasn't reached —
      // it must show up in the result, not vanish. Silent skips are how a survivor
      // ends up believing someone was told.
      attempts.push({ channel: channelName, ok: false, reason: 'unconfigured' });
      continue;
    }
    // Brief 31 — a reserved address (RFC 2606) cannot receive anything, so the
    // provider is never called and no production quota is spent. Recorded as its own
    // status: it is NOT a delivery (nothing arrived) and NOT a failure (nothing went
    // wrong), and conflating it with either would make the delivery log lie.
    if (isReservedDestination(channelName, endpoint.channelIdentifier)) {
      await recordDelivery(env, {
        eventId: message.eventId,
        messageKind: message.kind,
        channel: channelName,
        status: SUPPRESSED_STATUS,
        detail: SUPPRESSED_REASON,
      });
      attempts.push({ channel: channelName, ok: false, reason: SUPPRESSED_REASON });
      continue;
    }
    const ok = await sendMessage(channel, message);
    // Per-channel delivery record (Fix Brief 1 #5) — delivery is observable in
    // D1, not guessed. providerMessageId links back to the provider's own logs;
    // on failure, detail carries the provider's actual rejection reason so the
    // failure is never silent.
    await recordDelivery(env, {
      eventId: message.eventId,
      messageKind: message.kind,
      channel: channelName,
      status: ok ? 'delivered' : 'failed',
      providerMessageId: channel.lastProviderMessageId ?? null,
      detail: ok ? null : channel.lastError ?? 'send_failed',
    });
    attempts.push({ channel: channelName, ok, reason: ok ? null : (channel.lastError ?? 'send_failed') });
    if (ok) {
      // fellBack = something was tried before this and failed. That is the
      // difference between "delivered" and "delivered, but the preferred channel
      // is broken" — the second is still a success and must never be reported as
      // a failure, but it is worth knowing.
      const fellBack = attempts.length > 1;
      await audit(env, message.eventId, `notification_delivered_${channelName}`, actorHash,
        fellBack ? { fellBack: true, after: attempts.slice(0, -1).map((a) => a.channel).join(',') } : null);
      return { delivered: true, channel: channelName, fellBack, attempts };
    }
    await audit(env, message.eventId, `notification_failed_${channelName}`, actorHash, {
      reason: channel.lastError ?? 'send_failed',
    });
  }

  // Every channel this recipient has, failed. ONLY now is "not reached" honest.
  await audit(env, message.eventId, 'all_channels_failed', actorHash, {
    tried: attempts.map((a) => `${a.channel}:${a.reason ?? 'failed'}`).join(' | '),
  });
  return { delivered: false, channel: null, fellBack: false, attempts };
}
