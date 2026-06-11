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
  ClassificationUpdatePayload,
  ClosureRequestPayload,
  DuressAlertPayload,
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
export function activationAlert(eventId: string, p: ActivationAlertPayload): BuiltMessage {
  const bodyContents: LineMessage[] = [
    { type: 'text', text: `${p.userDisplayName} activated BLACK BOX.`, weight: 'bold', wrap: true, size: 'md' },
    { type: 'text', text: 'Live audio + location active.', wrap: true, color: MUTE, size: 'sm' },
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
        altText: `🚨 EMERGENCY — ${p.userDisplayName} activated BLACK BOX`,
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
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: "I'm responding",
                data: postbackData('responding', eventId),
                displayText: "I'm responding",
              },
            },
            { type: 'action', action: { type: 'uri', label: 'Call 110', uri: 'tel:110' } },
          ],
        },
      },
    ],
    fallback:
      `🚨 EMERGENCY — ${p.userDisplayName} activated BLACK BOX. ` +
      `Live audio + location active.\nLive dashboard: ${p.dashboardUrl}`,
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
                text: 'The recording will stop if you approve. Do you confirm she is safe?',
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
        altText: `⚠ DURESS — ${p.userDisplayName} entered her duress pin. Call emergency services now.`,
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
                text: `${p.userDisplayName} entered her duress pin. She is being forced to close the alert.`,
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
      `⚠ DURESS — ${p.userDisplayName} entered her duress pin. She is being forced to close the alert. ` +
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
