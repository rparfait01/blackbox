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
}

export interface ClassificationUpdatePayload {
  threatLevel: string;
  summary: string;
  dashboardUrl: string;
}

export interface ClosureRequestPayload {
  userDisplayName: string;
}

export interface DuressAlertPayload {
  userDisplayName: string;
}

export interface StandDownConfirmationPayload {
  /** Local time the contact stood the alert down, e.g. "18:42". */
  time: string;
}

/** Every channel ('push' | 'line' | 'telegram' | 'sms' | 'email'). */
export type ChannelName = 'push' | 'line' | 'telegram' | 'sms' | 'email';

export interface NotificationChannel {
  readonly channel: ChannelName;
  pushActivationAlert(eventId: string, payload: ActivationAlertPayload): Promise<boolean>;
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
  pushClosureConfirmation(eventId: string): Promise<boolean>;
  /** Confirmation that the contact's own stand-down ended the alert. */
  pushStandDownConfirmation(
    eventId: string,
    payload: StandDownConfirmationPayload,
  ): Promise<boolean>;
}
