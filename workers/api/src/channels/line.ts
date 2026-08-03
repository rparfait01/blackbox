/**
 * LINE Messaging API channel (W6). Pushes rich Flex messages to a single
 * contact's LINE user id, authenticated with the long-lived Channel Access
 * Token. Pushes are idempotent: the retry key is derived deterministically from
 * eventId + message type, so a retried activation alert never double-sends.
 *
 * Logging discipline: we log endpoint / status / latency / messageType only —
 * never the access token, the channelUserId, or any message contents.
 */

import { mayDispatchExternally } from '../lib/environment';
import type { Env } from '../types';
import { sha256Hex } from '@blackbox/shared';
import {
  activationAlert,
  checkinMessage,
  classificationUpdate,
  closureConfirmation,
  closureRequest,
  duressAlert,
  escalationAlert,
  standDownConfirmation,
  type BuiltMessage,
} from './messages';
import type {
  ActivationAlertPayload,
  CheckinPayload,
  ClassificationUpdatePayload,
  ClosureRequestPayload,
  DuressAlertPayload,
  EscalationAlertPayload,
  NotificationChannel,
  StandDownConfirmationPayload,
} from './types';

const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

/** Deterministic UUID (for the idempotent retry key) from a stable string. */
async function retryKey(seed: string): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(seed));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export class LineChannel implements NotificationChannel {
  readonly channel = 'line' as const;
  lastProviderMessageId: string | null = null;
  /** The provider's own failure reason (status + body), surfaced into the delivery
   *  record + audit so a LINE rejection is never silent. */
  lastError: string | null = null;

  constructor(
    private readonly accessToken: string,
    private readonly channelUserId: string,
    /** Brief 35 Fix B §A — needed to ask the bound database which environment this is. */
    private readonly env: Env,
  ) {}

  pushActivationAlert(eventId: string, payload: ActivationAlertPayload): Promise<boolean> {
    return this.send(eventId, 'activation', activationAlert(eventId, payload));
  }
  pushEscalation(eventId: string, payload: EscalationAlertPayload): Promise<boolean> {
    return this.send(eventId, 'escalation', escalationAlert(payload));
  }
  pushCheckin(eventId: string, payload: CheckinPayload): Promise<boolean> {
    // Time-varying content → nonce in the key so distinct check-ins all send.
    return this.send(`${eventId}:${payload.time}`, 'checkin', checkinMessage(payload));
  }

  pushClassificationUpdate(
    eventId: string,
    payload: ClassificationUpdatePayload,
  ): Promise<boolean> {
    // Time-varying content: include a nonce in the key so distinct updates send.
    return this.send(`${eventId}:${payload.summary}`, 'classification', classificationUpdate(payload));
  }

  pushClosureRequest(eventId: string, payload: ClosureRequestPayload): Promise<boolean> {
    return this.send(eventId, 'closure', closureRequest(eventId, payload));
  }

  pushDuressAlert(eventId: string, payload: DuressAlertPayload): Promise<boolean> {
    return this.send(eventId, 'duress', duressAlert(eventId, payload));
  }

  pushClosureConfirmation(eventId: string): Promise<boolean> {
    // The LINE confirmation text is generic; the userDisplayName payload is only
    // needed by subject-driven channels (email).
    return this.send(eventId, 'closure_confirm', closureConfirmation());
  }

  pushStandDownConfirmation(
    eventId: string,
    payload: StandDownConfirmationPayload,
  ): Promise<boolean> {
    return this.send(eventId, 'stand_down_confirm', standDownConfirmation(payload.time));
  }

  /**
   * Send a built message, falling back to its plain-text form if the Flex
   * message is rejected. Returns true only on a 200 from LINE.
   */
  private async send(keySeed: string, messageType: string, built: BuiltMessage): Promise<boolean> {
    const key = await retryKey(`${keySeed}:${messageType}`);
    const flexOk = await this.post(built.messages, key, messageType);
    if (flexOk) {
      return true;
    }
    // Fall back to a plain-text message (new retry key so it is not deduped
    // against the failed Flex attempt).
    const fallbackKey = await retryKey(`${keySeed}:${messageType}:fallback`);
    return this.post([{ type: 'text', text: built.fallback }], fallbackKey, `${messageType}_fallback`);
  }

  private async post(
    messages: Record<string, unknown>[],
    key: string,
    messageType: string,
  ): Promise<boolean> {
    // Brief 35 Fix B §A — the third and last provider boundary.
    const gate = await mayDispatchExternally(this.env);
    if (!gate.allowed) {
      console.log(
        JSON.stringify({
          provider: 'line',
          status: 'suppressed_environment',
          environment: gate.identity.name,
          messageType,
          wouldHaveSent: { to: this.channelUserId, messages },
        }),
      );
      this.lastError = 'suppressed_environment';
      return false;
    }

    const start = Date.now();
    try {
      const response = await fetch(PUSH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'X-Line-Retry-Key': key,
        },
        body: JSON.stringify({ to: this.channelUserId, messages }),
      });
      this.lastProviderMessageId = response.headers.get('x-line-request-id');
      console.log(
        JSON.stringify({
          channel: 'line',
          messageType,
          status: response.status,
          ms: Date.now() - start,
        }),
      );
      if (response.status === 200) {
        this.lastError = null;
        return true;
      }
      // Capture LINE's actual rejection reason (e.g. invalid 'to', expired token)
      // WITHOUT logging the recipient id — the body holds the diagnostic message,
      // not PII. Truncated so a verbose body can't bloat the audit row.
      const body = await response.text().catch(() => '');
      this.lastError = `line ${response.status}: ${body.slice(0, 200)}`;
      return false;
    } catch (e) {
      console.log(JSON.stringify({ channel: 'line', messageType, status: 'fetch_error' }));
      this.lastError = `line fetch_error: ${String(e).slice(0, 120)}`;
      return false;
    }
  }
}
