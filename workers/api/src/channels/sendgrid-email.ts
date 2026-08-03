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
import { UNAUTH_OUTBOUND, isAlertMessage } from '../lib/abuse-limits';
import { countOutbound } from '../lib/limiter-store';
import { mayDispatchExternally } from '../lib/environment';
import type { Env } from '../types';
import { isReservedEmail, SUPPRESSED_REASON, SUPPRESSED_ENVIRONMENT_REASON } from './reserved';

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
  /** True when the provider was deliberately NOT called because the address is
   *  reserved and cannot receive mail (Brief 31). Distinct from a failure: nothing
   *  went wrong, and — critically — no production quota was spent. */
  suppressed?: boolean;
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
  // THE SEVERANCE (Brief 31). Every email in the system — alerts, magic links, OTP,
  // guardian invites, integrity alarms — funnels through here, so this is the ONE
  // boundary at which production delivery quota is spent. A reserved address can
  // never receive mail from anyone, so spending a real send on it is pure waste of a
  // finite, life-safety resource. Return before the provider call.
  //
  // This is checked BEFORE the config check so the behaviour is identical whether or
  // not SendGrid is configured — a reserved address is undeliverable either way.
  if (isReservedEmail(message.to)) {
    console.log(`[SendGrid] SUPPRESSED ${messageType} — reserved address, no quota spent`);
    return { ok: false, status: 0, body: SUPPRESSED_REASON, suppressed: true };
  }

  /**
   * Brief 41 §C — THE RESERVED ALLOCATION. This is the item acceptance 3 is about.
   *
   * Brief 31 stopped the test suite draining the SendGrid quota. An unauthenticated attacker
   * could still do it — hammer /v1/auth/magic/start and every real alert afterwards reaches
   * nobody. That is an attack that takes the alert path down without ever touching the alert
   * path, and this system has already lived through the same outcome by accident: a real 05:21
   * alert reached no one because test runs had spent the credits first.
   *
   * So sends are split at the ONE place every message already passes through. Alert-path
   * messages are never counted and never capped — no volume of abuse can reduce what is
   * available to a survivor's cascade. Everything else draws on the ordinary allocation and is
   * capped per identifier.
   *
   * The classification is derived from the message type the CALLING CODE PATH supplies, not from
   * anything a request carries. There is no header or field that can promote a magic link to an
   * alert.
   */
  if (!isAlertMessage(messageType)) {
    const cap = await countOutbound(env, message.to.trim().toLowerCase(), UNAUTH_OUTBOUND.windowMs, UNAUTH_OUTBOUND.max);
    if (!cap.allowed) {
      console.log(
        JSON.stringify({
          level: 'warn',
          outbound: 'capped',
          messageType,
          used: cap.used,
          max: UNAUTH_OUTBOUND.max,
          reason: UNAUTH_OUTBOUND.reason,
        }),
      );
      return { ok: false, status: 0, body: 'outbound_cap_reached', suppressed: true };
    }
    if (cap.failedOpen) {
      // §E3 — a survivor's magic link is not withheld because a counter was unreachable.
      console.log(JSON.stringify({ level: 'warn', outbound: 'failed_open', messageType }));
    }
  }
  /**
   * Brief 35 Fix B §A — ENVIRONMENT SUPPRESSION, before any provider is reached.
   *
   * Placed after the reserved-address and abuse-cap checks and before the config read, so the
   * decision is identical whether or not a credential happens to be present. §C removes staging's
   * credentials as a second barrier; this is the first, and neither relies on the other.
   *
   * INDETERMINATE dispatches (§B). The failure that matters is not a leaked staging email, it is
   * production deciding it is not production and swallowing a real cascade.
   */
  const gate = await mayDispatchExternally(env);
  if (!gate.allowed) {
    console.log(
      JSON.stringify({
        provider: 'sendgrid',
        status: 'suppressed_environment',
        environment: gate.identity.name,
        messageType,
        // §A — the full payload that WOULD have been sent, so staging acceptance can assert on
        // content without transmitting it.
        wouldHaveSent: { to: message.to, subject: message.subject, text: message.text },
      }),
    );
    return { ok: false, status: 0, body: SUPPRESSED_ENVIRONMENT_REASON, suppressed: true };
  }

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
  /** SendGrid's actual rejection (status + body) so an email failure is never
   *  recorded as a bare "send_failed" — the delivery log carries the real reason. */
  lastError: string | null = null;
  /** True when the last send was deliberately not handed to the provider because the
   *  address is reserved (Brief 31) — recorded distinctly from a real failure. */
  lastSuppressed = false;

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
      this.lastSuppressed = r.suppressed === true;
      this.lastError = r.ok
        ? null
        : r.suppressed
          ? SUPPRESSED_REASON
          : `sendgrid_${r.status}: ${(r.body || '(empty)').slice(0, 180)}`;
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
