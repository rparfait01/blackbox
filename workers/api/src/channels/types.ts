/**
 * Notification channel abstraction (W6). A channel is how an activation reaches
 * a contact. Only LINE is implemented in v0; the interface is shaped so a
 * Telegram (or web-push, email) channel can be added later without touching the
 * call sites. Telegram is explicitly NOT built in W6.
 *
 * Contact-side messaging philosophy: the covert constraint protects the USER's
 * phone, where an aggressor may be physically present. The contact is elsewhere,
 * with no co-located threat — so every message a channel sends is MAXIMALLY
 * clear and urgent, never subtle. See messages.ts.
 *
 * Every method returns `true` only when the provider ACCEPTED the message for
 * delivery (LINE push API returned 200) — that acceptance, recorded server-side
 * as `notification_delivered_line`, is the "contact notified" step of the
 * acknowledgment loop. Nothing is ever signalled back to the user's phone.
 */

export interface ActivationAlertPayload {
  /** The user's name — the subject of the alert ("[name] activated BLACK BOX"). */
  userDisplayName: string;
  /** Magic-link URL to the read-only live view (no login). */
  dashboardUrl: string;
  /** Magic-link URL that streams the latest audio chunk. */
  audioUrl: string;
  /** Latest known location, if any fix has arrived yet. */
  location?: { lat: number; lon: number } | null;
  /** Latest descriptive classification summary, if any. */
  threatSummary?: string | null;
  /** Locale-correct emergency numbers, resolved from the account region so the
   *  LINE "Call" action matches the dashboard everywhere (Brief 12 P3). */
  emergency?: { police: string; ambulance: string } | null;
}

export interface ClassificationUpdatePayload {
  threatLevel: string;
  summary: string;
  dashboardUrl: string;
}

export interface ClosureRequestPayload {
  userDisplayName: string;
  /** Dashboard link (used by channels without inline buttons, e.g. email). */
  dashboardUrl?: string;
}

export interface DuressAlertPayload {
  userDisplayName: string;
  dashboardUrl?: string;
}

export interface ClosureConfirmationPayload {
  userDisplayName: string;
}

export interface StandDownConfirmationPayload {
  /** Local time the contact stood the alert down, e.g. "18:42". */
  time: string;
  userDisplayName: string;
}

/**
 * "Device went dark" escalation (Fix Brief 1 #3). Fired when an active event
 * stops heart-beating (missed heartbeat) or the client reports itself lost. An
 * interruption ESCALATES, it never cancels — so this tells the contact the
 * phone went dark while the alert is still active, and to treat it as MORE
 * urgent, not resolved.
 */
export interface EscalationAlertPayload {
  userDisplayName: string;
  dashboardUrl: string;
  /** Why we escalated: 'device_dark' (missed heartbeat) | 'client_lost' (pagehide). */
  reason: 'device_dark' | 'client_lost';
  /** Local time of the last contact with the device, e.g. "18:42". */
  lastSeen?: string | null;
  location?: { lat: number; lon: number } | null;
}

/**
 * Check-in ("I'm OK") — a calm, NON-emergency reassurance ping (Brief 10). No
 * event, no capture. Location is included ONLY if the user opted in for this tap.
 */
export interface CheckinPayload {
  userDisplayName: string;
  /** Local time of the check-in, e.g. "18:42". */
  time: string;
  location?: { lat: number; lon: number } | null;
}

/** Every channel ('push' | 'line' | 'telegram' | 'sms' | 'email'). */
export type ChannelName = 'push' | 'line' | 'telegram' | 'sms' | 'email';

export interface NotificationChannel {
  readonly channel: ChannelName;
  /**
   * Provider message id of the most recent send, when the provider returns one
   * (SendGrid X-Message-Id, LINE x-line-request-id). Recorded in delivery_records
   * so a delivery can be traced back to the provider's own logs. Optional —
   * channels that have no such id leave it undefined.
   */
  readonly lastProviderMessageId?: string | null;
  pushActivationAlert(eventId: string, payload: ActivationAlertPayload): Promise<boolean>;
  /** "Device went dark" escalation — interruption escalates, never cancels. */
  pushEscalation(eventId: string, payload: EscalationAlertPayload): Promise<boolean>;
  /** Calm "I'm OK" check-in (Brief 10) — never resembles an emergency message. */
  pushCheckin(eventId: string, payload: CheckinPayload): Promise<boolean>;
  pushClassificationUpdate(eventId: string, payload: ClassificationUpdatePayload): Promise<boolean>;
  pushClosureRequest(eventId: string, payload: ClosureRequestPayload): Promise<boolean>;
  /**
   * Duress is a DISTINCT message, not a variant of the closure request: it
   * carries NO approval affordance. The user's duress entry already overrode any
   * approval, so the contact must not be able to "approve away" the signal — the
   * message tells them to call emergency services directly.
   */
  pushDuressAlert(eventId: string, payload: DuressAlertPayload): Promise<boolean>;
  /** Confirmation to the contact that an approved closure has stopped recording. */
  pushClosureConfirmation(eventId: string, payload: ClosureConfirmationPayload): Promise<boolean>;
  /** Confirmation that the contact's own stand-down ended the alert. */
  pushStandDownConfirmation(
    eventId: string,
    payload: StandDownConfirmationPayload,
  ): Promise<boolean>;
}
