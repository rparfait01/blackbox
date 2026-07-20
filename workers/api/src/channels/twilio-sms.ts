/**
 * Twilio SMS channel. SMS is the DEFAULT primary channel (Twilio compliance
 * approved), but the dispatcher is channel-agnostic: a recipient's ordered
 * channel list decides routing; SMS is just first when present. The Twilio
 * message SID is captured into lastProviderMessageId so SMS delivery is
 * observable in delivery_records alongside SendGrid/LINE ids.
 *
 * Config (secrets): TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, and either
 * TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM_NUMBER.
 *
 * Logging discipline: log channel/status/latency/messageType only — never the
 * auth token, the recipient number, or message contents.
 */

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

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
}

export function twilioConfig(env: Env): TwilioConfig | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  if (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM_NUMBER) {
    return null;
  }
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    fromNumber: env.TWILIO_FROM_NUMBER,
  };
}

/**
 * Low-level SMS send, decoupled from the alert-payload channel. Used for the
 * consent confirmation flow (which is not an "alert" and carries no payload) and
 * reused by TwilioSmsChannel below. Returns the outcome; NEVER throws — an SMS
 * failure must never bubble into a contact-save or a webhook ack.
 * Logging discipline: channel/status/latency only — never the number or the body.
 */
export async function sendSms(
  env: Env,
  toNumber: string,
  body: string,
  messageType = 'transactional',
): Promise<{ ok: boolean; sid: string | null; status: number }> {
  const config = twilioConfig(env);
  if (!config) {
    console.log(JSON.stringify({ channel: 'sms', messageType, status: 'not_configured' }));
    return { ok: false, sid: null, status: 0 };
  }
  const start = Date.now();
  const form = new URLSearchParams();
  form.set('To', toNumber);
  if (config.messagingServiceSid) {
    form.set('MessagingServiceSid', config.messagingServiceSid);
  } else if (config.fromNumber) {
    form.set('From', config.fromNumber);
  }
  form.set('Body', body);
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    const ok = response.status >= 200 && response.status < 300;
    let sid: string | null = null;
    try {
      const data = (await response.json()) as { sid?: string };
      sid = data.sid ?? null;
    } catch {
      sid = null;
    }
    console.log(JSON.stringify({ channel: 'sms', messageType, status: response.status, ms: Date.now() - start }));
    return { ok, sid, status: response.status };
  } catch (error) {
    console.log(JSON.stringify({ channel: 'sms', messageType, status: 'fetch_error', detail: String(error) }));
    return { ok: false, sid: null, status: 0 };
  }
}

export class TwilioSmsChannel implements NotificationChannel {
  readonly channel = 'sms' as const;
  lastProviderMessageId: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly toNumber: string,
  ) {}

  pushActivationAlert(_e: string, p: ActivationAlertPayload): Promise<boolean> {
    const where = p.location ? ` Location: ${p.location.lat.toFixed(4)},${p.location.lon.toFixed(4)}.` : '';
    return this.send('activation', `🚨 ${p.userDisplayName} activated BLACK BOX. Live audio + location.${where} Open: ${p.dashboardUrl}`);
  }
  pushEscalation(_e: string, p: EscalationAlertPayload): Promise<boolean> {
    return this.send('escalation', `🚨 ${p.userDisplayName}'s phone went dark — ALERT STILL ACTIVE, more urgent not resolved. Open: ${p.dashboardUrl}`);
  }
  pushCheckin(_e: string, p: CheckinPayload): Promise<boolean> {
    const loc = p.location ? ` (loc: ${p.location.lat.toFixed(4)},${p.location.lon.toFixed(4)})` : '';
    return this.send('checkin', `✓ ${p.userDisplayName} checked in — I'm OK at ${p.time}.${loc} Reassurance only, not an alert.`);
  }
  pushClassificationUpdate(_e: string, p: ClassificationUpdatePayload): Promise<boolean> {
    return this.send('classification', `BLACK BOX update — ${p.summary} (threat: ${p.threatLevel}). ${p.dashboardUrl}`);
  }
  pushClosureRequest(_e: string, p: ClosureRequestPayload): Promise<boolean> {
    return this.send('closure', `${p.userDisplayName} requested closure. Review before standing down: ${p.dashboardUrl ?? ''}`);
  }
  pushDuressAlert(_e: string, p: DuressAlertPayload): Promise<boolean> {
    return this.send('duress', `⚠ DURESS — ${p.userDisplayName} entered their duress code. Recording continues. Call emergency services now. ${p.dashboardUrl ?? ''}`);
  }
  pushClosureConfirmation(_e: string, p: ClosureConfirmationPayload): Promise<boolean> {
    return this.send('closure_confirm', `✓ ${p.userDisplayName}'s alert is closed — recording has stopped.`);
  }
  pushStandDownConfirmation(_e: string, p: StandDownConfirmationPayload): Promise<boolean> {
    return this.send('stand_down_confirm', `✓ Alert for ${p.userDisplayName} ended at ${p.time}. Recording has stopped.`);
  }

  private async send(messageType: string, body: string): Promise<boolean> {
    const res = await sendSms(this.env, this.toNumber, body, messageType);
    this.lastProviderMessageId = res.sid;
    return res.ok;
  }
}
