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
  emailDuress,
  emailStandDownConfirmation,
  type BuiltEmail,
} from './email-messages';
import type {
  ActivationAlertPayload,
  ClassificationUpdatePayload,
  ClosureConfirmationPayload,
  ClosureRequestPayload,
  DuressAlertPayload,
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

/** Low-level send. Returns true only on a 2xx from SendGrid. */
export async function sendEmail(
  env: Env,
  message: { to: string; subject: string; html: string; text: string },
  messageType = 'email',
): Promise<boolean> {
  const config = sendgridConfig(env);
  if (!config) {
    console.log(JSON.stringify({ channel: 'email', messageType, status: 'unconfigured' }));
    return false;
  }
  const start = Date.now();
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
    console.log(
      JSON.stringify({ channel: 'email', messageType, status: response.status, ms: Date.now() - start }),
    );
    return response.status >= 200 && response.status < 300;
  } catch {
    console.log(JSON.stringify({ channel: 'email', messageType, status: 'fetch_error' }));
    return false;
  }
}

export class SendGridEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;

  constructor(
    private readonly env: Env,
    private readonly toEmail: string,
  ) {}

  private send(messageType: string, built: BuiltEmail): Promise<boolean> {
    return sendEmail(
      this.env,
      { to: this.toEmail, subject: built.subject, html: built.html, text: built.text },
      messageType,
    );
  }

  pushActivationAlert(_eventId: string, payload: ActivationAlertPayload): Promise<boolean> {
    return this.send('activation', emailActivation(payload));
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
