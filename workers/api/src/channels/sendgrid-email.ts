/**
 * SendGrid email channel (W8A). Implements NotificationChannel so the router can
 * route any alert to a contact's email endpoint. Also exports a generic
 * `sendEmail` used for transactional mail (OTP codes, guardian invites).
 *
 * Logging discipline: log endpoint / status / latency / messageType only — never
 * the API key, recipient address, or message contents.
 */

import {
  emailActivation,
  emailClassificationUpdate,
  emailClosureConfirmation,
  emailClosureRequest,
  emailCheckin,
  emailDuress,
  emailEscalation,
  emailStandDownConfirmation,
  type BuiltEmail,
} from './email-messages';
import type {
  ActivationAlertPayload,
  CheckinPayload,
  ClassificationUpdatePayload,
  ClosureConfirmationPayload,
  ClosureRequestPayload,
  DuressAlertPayload,
  EscalationAlertPayload,
  NotificationChannel,
  StandDownConfirmationPayload,
} from './types';
import type { Env } from '../types';

const SEND_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

export interface EmailConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

/** Resolve SendGrid config from env, or null if not configured. */
export function sendgridConfig(env: Env): EmailConfig | null {
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
    return null;
  }
  return {
    apiKey: env.SENDGRID_API_KEY,
    fromEmail: env.SENDGRID_FROM_EMAIL,
    fromName: env.SENDGRID_FROM_NAME ?? 'BLACK BOX',
  };
}

export interface SendResult {
  ok: boolean;
  /** HTTP status from SendGrid, or 0 if the request never completed. */
  status: number;
  /** SendGrid response body (empty on success; JSON error detail on failure). */
  body: string;
  /** SendGrid X-Message-Id (links to the Activity Feed), when present. */
  messageId?: string | null;
}

/**
 * Low-level send. Awaits the SendGrid API and returns the full outcome (status +
 * body) so callers can surface real errors instead of a silent boolean. Every
 * attempt is logged to console (visible in Cloudflare Observability).
 */
export async function sendEmail(
  env: Env,
  message: { to: string; subject: string; html: string; text: string },
  messageType = 'email',
): Promise<SendResult> {
  const config = sendgridConfig(env);
  if (!config) {
    console.log('[SendGrid] NOT configured — missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL');
    return { ok: false, status: 0, body: 'sendgrid_not_configured' };
  }
  const start = Date.now();
  console.log(`[SendGrid] sending ${messageType} to ${message.to} (from ${config.fromEmail})`);
  try {
    const response = await fetch(SEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: config.fromEmail, name: config.fromName },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });
    // SendGrid returns 202 with an EMPTY body on success; errors carry JSON.
    const body = await response.text();
    // X-Message-Id ties this send to a row in the SendGrid Activity Feed.
    const messageId = response.headers.get('x-message-id');
    console.log(`[SendGrid] response status ${response.status} (${Date.now() - start}ms)`);
    console.log(`[SendGrid] response body ${body || '(empty)'} messageId ${messageId ?? '(none)'}`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body,
      messageId,
    };
  } catch (error) {
    const body = error instanceof Error ? error.message : 'fetch_error';
    console.log(`[SendGrid] fetch error ${body}`);
    return { ok: false, status: 0, body };
  }
}

export class SendGridEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  lastProviderMessageId: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly toEmail: string,
  ) {}

  private send(messageType: string, built: BuiltEmail): Promise<boolean> {
    return sendEmail(
      this.env,
      { to: this.toEmail, subject: built.subject, html: built.html, text: built.text },
      messageType,
    ).then((r) => {
      this.lastProviderMessageId = r.messageId ?? null;
      return r.ok;
    });
  }

  pushActivationAlert(_eventId: string, payload: ActivationAlertPayload): Promise<boolean> {
    return this.send('activation', emailActivation(payload));
  }
  pushEscalation(_eventId: string, payload: EscalationAlertPayload): Promise<boolean> {
    return this.send('escalation', emailEscalation(payload));
  }
  pushCheckin(_eventId: string, payload: CheckinPayload): Promise<boolean> {
    return this.send('checkin', emailCheckin(payload));
  }
  pushClassificationUpdate(_eventId: string, payload: ClassificationUpdatePayload): Promise<boolean> {
    return this.send('classification', emailClassificationUpdate(payload));
  }
  pushClosureRequest(_eventId: string, payload: ClosureRequestPayload): Promise<boolean> {
    return this.send('closure', emailClosureRequest(payload));
  }
  pushDuressAlert(_eventId: string, payload: DuressAlertPayload): Promise<boolean> {
    return this.send('duress', emailDuress(payload));
  }
  pushClosureConfirmation(_eventId: string, payload: ClosureConfirmationPayload): Promise<boolean> {
    return this.send('closure_confirm', emailClosureConfirmation(payload));
  }
  pushStandDownConfirmation(
    _eventId: string,
    payload: StandDownConfirmationPayload,
  ): Promise<boolean> {
    return this.send('stand_down_confirm', emailStandDownConfirmation(payload));
  }
}
