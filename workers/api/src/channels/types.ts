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
  /** §5: CAD-ready structured summary URL for the emergency-services tier. */
  summaryUrl?: string;
  /** Magic-link URL that streams the latest audio chunk. */
  audioUrl: string;
  /**
   * Brief 33 Fix B §D — is VIDEO actually capturing right now?
   *
   * Derived from the mimeType of a chunk the server has actually received, never from a device
   * capability or an intention. The message names video only when this is true; otherwise it
   * reads "Live audio + location active."
   *
   * NEVER CLAIM A CAPTURE THAT IS NOT HAPPENING. A responder who reads "live video" and opens a
   * dashboard with no picture does not conclude the camera failed — they conclude the system
   * lies, at the moment they most need to trust it. Undefined means unknown, and unknown claims
   * nothing.
   */
  hasVideo?: boolean;
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
  /**
   * Why we escalated:
   *  - 'device_dark'   — missed heartbeat (phone off/taken/dead)
   *  - 'client_lost'   — pagehide beacon (app closed/lost connection)
   *  - 'link_reissued' — the prior coordinator link EXPIRED on an unresolved
   *                      event, so a FRESH live link was minted and re-sent. The
   *                      path to closure regenerates; it never dead-ends.
   */
  reason: 'device_dark' | 'client_lost' | 'link_reissued';
  /** Local time of the last contact with the device, e.g. "18:42". */
  lastSeen?: string | null;
  location?: { lat: number; lon: number } | null;
  /**
   * Provenance carried by a 'link_reissued' re-notification so the recipient sees
   * exactly what they are being asked to resolve (every field render-only, local
   * time). Absent for device_dark / client_lost.
   */
  provenance?: {
    /** Who triggered: account owner name + email. */
    triggeredByName: string | null;
    triggeredByEmail: string | null;
    /** When the alert was triggered (date + local time). */
    triggeredAt: string | null;
    /** When the previous link expired (date + local time). */
    linkExpiredAt: string | null;
    /** When THIS re-notification was sent (date + local time). */
    notifiedAt: string | null;
    /** Contact required to confirm closure (coordinator of last resort): name + email. */
    closerName: string | null;
    closerEmail: string | null;
  };
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
/**
 * Every channel the ONE dispatcher knows about. Channels are INPUTS to the
 * dispatcher, not separate systems — adding one means a case in
 * channels/router.ts `createChannel` and an entry here, never a new send path.
 *
 * 'whatsapp' is the proof of that seam: named and routable, deliberately unbuilt
 * (isChannelDeliverable → false, so it resolves to a stub and cannot be saved on
 * a contact). 'email' is being retired from the ALERT path — see
 * isChannelDeliverable for why it is still live.
 */
export type ChannelName = 'push' | 'line' | 'telegram' | 'sms' | 'email' | 'whatsapp';

export interface NotificationChannel {
  readonly channel: ChannelName;
  /**
   * Provider message id of the most recent send, when the provider returns one
   * (SendGrid X-Message-Id, LINE x-line-request-id). Recorded in delivery_records
   * so a delivery can be traced back to the provider's own logs. Optional —
   * channels that have no such id leave it undefined.
   */
  readonly lastProviderMessageId?: string | null;
  /**
   * Provider failure reason of the most recent send (status + truncated body),
   * when the send failed. Recorded into delivery_records.detail + audit so a
   * rejection is observable, never silent. Undefined/null on success.
   */
  readonly lastError?: string | null;
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
