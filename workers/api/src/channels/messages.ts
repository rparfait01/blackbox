/**
 * LINE message builders (W6). The contact is in a safe location, away from the
 * aggressor — so these are LOUD and unambiguous, never covert. The covert
 * constraints apply only to the user's own phone surface.
 *
 * Each builder returns the LINE `messages` array (a rich Flex bubble) plus a
 * plain-text fallback used if the Flex send is rejected. Reference design:
 * docs/blackbox_line_alert.html.
 */

import type {
  ActivationAlertPayload,
  CheckinPayload,
  ClassificationUpdatePayload,
  ClosureRequestPayload,
  DuressAlertPayload,
  EscalationAlertPayload,
} from './types';

const RED = '#FF3B30';
const INK = '#1A1A1A';
const MUTE = '#666666';

type LineMessage = Record<string, unknown>;

export interface BuiltMessage {
  messages: LineMessage[];
  /** Plain-text fallback (used if the Flex message is rejected by LINE). */
  fallback: string;
}

/** Encode a postback payload as a compact query string. */
export function postbackData(action: string, eventId: string): string {
  return `action=${action}&eventId=${encodeURIComponent(eventId)}`;
}

function coordLabel(location: ActivationAlertPayload['location']): string | null {
  if (!location) {
    return null;
  }
  return `${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°`;
}

function infoRow(label: string, value: string): LineMessage {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: MUTE, flex: 2 },
      { type: 'text', text: value, size: 'sm', color: INK, flex: 5, wrap: true },
    ],
  };
}

/** EMERGENCY activation alert — red header, location, audio + dashboard links. */
/**
 * Brief 33 Fix B §D — WHAT IS ACTUALLY CAPTURING, in one place.
 *
 * Four channels carry this sentence (LINE, SMS, email, push) and they used to spell it four
 * times. A line that must be literally true is the last thing to keep four copies of: the first
 * one someone forgets to update becomes a claim the system cannot back.
 *
 * VIDEO IS NAMED ONLY ON EVIDENCE. `hasVideo` is derived from the mimeType of a chunk the server
 * has actually received — not a device capability, not an intention, not a config flag. When it
 * is false or unknown the line reads "Live audio + location active", which is the truthful
 * subset. If Brief 50 finds video unavailable on a platform, this needs no change: no video
 * chunks arrive, so no video is claimed.
 *
 * A responder who reads "live video" and opens a dashboard showing no picture does not conclude
 * the camera failed. They conclude the system lies — at the moment they most need to trust it.
 */
export function captureLine(hasVideo: boolean | undefined): string {
  return hasVideo ? 'Live video + audio + location active.' : 'Live audio + location active.';
}

export function activationAlert(_eventId: string, p: ActivationAlertPayload): BuiltMessage {
  // Locale-correct emergency number (Brief 12 P3) — falls back to the JP pilot
  // default so the LINE action never disagrees with the dashboard.
  const police = p.emergency?.police ?? '110';
  const bodyContents: LineMessage[] = [
    { type: 'text', text: `${p.userDisplayName} activated SENTINEL ALERT.`, weight: 'bold', wrap: true, size: 'md' },
    { type: 'text', text: captureLine(p.hasVideo), wrap: true, color: MUTE, size: 'sm' },
    { type: 'separator', margin: 'md' },
  ];
  const coords = coordLabel(p.location);
  if (coords) {
    bodyContents.push(infoRow('WHERE', coords));
  }
  if (p.threatSummary) {
    bodyContents.push(infoRow('HEARD', p.threatSummary));
  }

  return {
    messages: [
      {
        type: 'flex',
        altText: `🚨 EMERGENCY — ${p.userDisplayName} activated SENTINEL ALERT`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: RED,
            paddingAll: '14px',
            contents: [
              { type: 'text', text: '🚨 EMERGENCY', color: '#FFFFFF', weight: 'bold', size: 'xl' },
            ],
          },
          body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: RED,
                height: 'sm',
                action: { type: 'uri', label: 'OPEN LIVE DASHBOARD', uri: p.dashboardUrl },
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: { type: 'uri', label: '▶ Audio preview', uri: p.audioUrl },
              },
            ],
          },
        },
        // One claim only (Brief 12 P2): coordination is claimed by the deliberate
        // "Take coordination" POST on the dashboard, so there is NO "I'm
        // responding" quick reply here that would be a second claim for one
        // commitment. The remaining quick action is the direct emergency call.
        quickReply: {
          items: [
            { type: 'action', action: { type: 'uri', label: `Call ${police}`, uri: `tel:${police}` } },
          ],
        },
      },
    ],
    fallback:
      `🚨 EMERGENCY — ${p.userDisplayName} activated SENTINEL ALERT.\n` +
      `${captureLine(p.hasVideo)}\nLive dashboard: ${p.dashboardUrl}`,
  };
}

/**
 * Escalation — red, explicit, NO resolution affordance. Two shapes:
 *  - device_dark / client_lost: the phone went dark while still active.
 *  - link_reissued: the prior link expired on an unresolved event, so a FRESH
 *    live link + provenance is re-sent (the path regenerates, never dead-ends).
 */
export function escalationAlert(p: EscalationAlertPayload): BuiltMessage {
  const reissued = p.reason === 'link_reissued';
  const headerText = reissued ? '🚨 STILL ACTIVE — NEW LINK' : '🚨 DEVICE WENT DARK';
  const lead = reissued
    ? `${p.userDisplayName}'s alert is STILL ACTIVE and unsecured.`
    : `${p.userDisplayName}'s phone went dark. THE ALERT IS STILL ACTIVE.`;
  const sub = reissued
    ? 'The earlier link expired and no one has secured it. This link is live now.'
    : `${
        p.reason === 'client_lost'
          ? `${p.userDisplayName}'s phone closed the app or lost connection while the alert was still active.`
          : `${p.userDisplayName}'s phone stopped checking in while the alert was still active.`
      } This is more urgent, not resolved.`;
  const body: LineMessage[] = [
    { type: 'text', text: lead, weight: 'bold', wrap: true },
    { type: 'text', text: sub, wrap: true, color: RED, size: 'sm' },
  ];
  if (reissued && p.provenance) {
    const pv = p.provenance;
    if (pv.triggeredByName || pv.triggeredByEmail) {
      body.push(infoRow('TRIGGERED BY', [pv.triggeredByName, pv.triggeredByEmail].filter(Boolean).join(' · ')));
    }
    if (pv.triggeredAt) {
      body.push(infoRow('TRIGGERED AT', pv.triggeredAt));
    }
    if (pv.linkExpiredAt) {
      body.push(infoRow('LINK EXPIRED', pv.linkExpiredAt));
    }
    if (pv.notifiedAt) {
      body.push(infoRow('NOTICE SENT', pv.notifiedAt));
    }
    if (pv.closerName || pv.closerEmail) {
      body.push(infoRow('MUST CONFIRM', [pv.closerName, pv.closerEmail].filter(Boolean).join(' · ')));
    }
  }
  if (p.lastSeen) {
    body.push(infoRow('LAST SEEN', p.lastSeen));
  }
  const coords = coordLabel(p.location ?? null);
  if (coords) {
    body.push(infoRow('LAST WHERE', coords));
  }
  return {
    messages: [
      {
        type: 'flex',
        altText: reissued
          ? `🚨 ${p.userDisplayName} STILL NEEDS HELP — fresh link`
          : `🚨 ${p.userDisplayName}'s phone went dark — ALERT STILL ACTIVE`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: RED,
            paddingAll: '14px',
            contents: [{ type: 'text', text: headerText, color: '#FFFFFF', weight: 'bold', size: 'lg' }],
          },
          body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: RED,
                height: 'sm',
                action: {
                  type: 'uri',
                  label: reissued ? 'OPEN LIVE DASHBOARD (NEW LINK)' : 'OPEN LIVE DASHBOARD',
                  uri: p.dashboardUrl,
                },
              },
            ],
          },
        },
      },
    ],
    fallback:
      `🚨 ${lead} ${sub} ` + `Dashboard${reissued ? ' (new link)' : ''}: ${p.dashboardUrl}`,
  };
}

/** Normal closure request — standard color, Approve / Hold buttons. */
export function closureRequest(eventId: string, p: ClosureRequestPayload): BuiltMessage {
  return {
    messages: [
      {
        type: 'flex',
        altText: `${p.userDisplayName} has requested closure of the active session.`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: INK,
            paddingAll: '14px',
            contents: [
              { type: 'text', text: 'CLOSURE REQUESTED', color: '#FFFFFF', weight: 'bold', size: 'md' },
            ],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: `${p.userDisplayName} has requested closure of the active session.`,
                weight: 'bold',
                wrap: true,
              },
              {
                type: 'text',
                text: 'The recording will stop if you approve. Do you confirm they are safe?',
                wrap: true,
                color: MUTE,
                size: 'sm',
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#34C759',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: 'Approve closure',
                  data: postbackData('approve_closure', eventId),
                  displayText: 'Approve closure',
                },
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: 'Hold — something feels wrong',
                  data: postbackData('hold_closure', eventId),
                  displayText: 'Hold — something feels wrong',
                },
              },
            ],
          },
        },
      },
    ],
    fallback: `${p.userDisplayName} has requested closure of the active session. Reply APPROVE to stop recording, or HOLD if something feels wrong.`,
  };
}

/**
 * Duress alert — red, explicit, NO approve button. The user entered a duress
 * pin: they are being forced to close the alert. Recording continues regardless
 * of the contact's response; the only action offered is acknowledgement.
 */
export function duressAlert(eventId: string, p: DuressAlertPayload): BuiltMessage {
  return {
    messages: [
      {
        type: 'flex',
        altText: `⚠ DURESS — ${p.userDisplayName} entered their duress pin. Call emergency services now.`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: RED,
            paddingAll: '14px',
            contents: [
              {
                type: 'text',
                text: '⚠ DURESS PIN ENTERED — DO NOT APPROVE',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'md',
                wrap: true,
              },
            ],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: `${p.userDisplayName} entered their duress pin. They are being forced to close the alert.`,
                weight: 'bold',
                wrap: true,
              },
              {
                type: 'text',
                text: 'Recording continues regardless of your response. Call emergency services now.',
                wrap: true,
                color: RED,
                size: 'sm',
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: RED,
                height: 'sm',
                action: {
                  type: 'postback',
                  label: 'Acknowledge — I am calling for help',
                  data: postbackData('duress_ack', eventId),
                  displayText: 'Acknowledge — I am calling for help',
                },
              },
            ],
          },
        },
      },
    ],
    fallback:
      `⚠ DURESS — ${p.userDisplayName} entered their duress pin. They are being forced to close the alert. ` +
      `Recording continues. Call emergency services now.`,
  };
}

/** Confirmation to the contact that an approved closure stopped recording. */
export function closureConfirmation(): BuiltMessage {
  return {
    messages: [
      { type: 'text', text: '✓ Closure approved — recording has stopped. The session is closed.' },
    ],
    fallback: '✓ Closure approved — recording has stopped.',
  };
}

/** Confirmation that the contact's own stand-down ended the alert. */
export function standDownConfirmation(time: string): BuiltMessage {
  const text = `✓ You stood down the alert at ${time}. Recording has stopped and the session is closed.`;
  return { messages: [{ type: 'text', text }], fallback: text };
}

/** Calm "I'm OK" check-in (Brief 10) — plain, reassuring, never emergency-styled.
 *  The shared location is a real, tappable map link, not bare coordinates (Brief
 *  19) — LINE auto-links the URL in a plain-text message. */
export function checkinMessage(p: CheckinPayload): BuiltMessage {
  const loc = p.location
    ? `\nShared location: https://www.google.com/maps/search/?api=1&query=${p.location.lat.toFixed(5)},${p.location.lon.toFixed(5)}`
    : '';
  const text = `✓ ${p.userDisplayName} checked in — I'm OK at ${p.time}.${loc}`;
  return { messages: [{ type: 'text', text }], fallback: text };
}

/** A short threat-update push (optional; not auto-sent in v0 to conserve quota). */
export function classificationUpdate(p: ClassificationUpdatePayload): BuiltMessage {
  return {
    messages: [
      {
        type: 'text',
        text: `Update — ${p.summary} (threat: ${p.threatLevel}).\nLive dashboard: ${p.dashboardUrl}`,
      },
    ],
    fallback: `Update — ${p.summary} (threat: ${p.threatLevel}). ${p.dashboardUrl}`,
  };
}
