/**
 * Email message builders (W8A). The contact reads these on a lock screen or a
 * watch, where the SUBJECT renders before the body — so the subject IS the
 * alert (exact formats below are non-negotiable). Bodies mirror the loud red
 * dashboard preview used for LINE, with a plain-text alternative for clients
 * that strip HTML.
 */

import type {
  ActivationAlertPayload,
  CheckinPayload,
  ClassificationUpdatePayload,
  ClosureConfirmationPayload,
  ClosureRequestPayload,
  DuressAlertPayload,
  EscalationAlertPayload,
  StandDownConfirmationPayload,
} from './types';

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const RED = '#ff3b30';
const INK = '#1a1a1a';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A clickable map link for a coordinate (Brief 19). Universal Google Maps search
 *  URL — opens the native maps app on phones, the web map elsewhere. */
export function mapLink(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

// A row is [label, value] or [label, value, href] — with an href the value renders
// as a tappable link (used for shared/last locations → a real map link).
type Row = [string, string] | [string, string, string];

interface ShellOpts {
  headerColor: string;
  headerText: string;
  rows: Row[];
  ctaUrl?: string;
  ctaText?: string;
  note?: string;
}

function shell(o: ShellOpts): string {
  const rows = o.rows
    .map(
      ([k, v, href]) =>
        `<tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.06em;width:90px">${escapeHtml(
          k,
        )}</td><td style="padding:6px 0;color:#111;font-size:14px">${
          href
            ? `<a href="${escapeHtml(href)}" style="color:#1558d6;text-decoration:underline">${escapeHtml(v)}</a>`
            : escapeHtml(v)
        }</td></tr>`,
    )
    .join('');
  const cta = o.ctaUrl
    ? `<tr><td colspan="2" style="padding-top:18px"><a href="${escapeHtml(
        o.ctaUrl,
      )}" style="display:block;background:${RED};color:#fff;text-align:center;padding:16px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:.04em;text-decoration:none">${escapeHtml(
        o.ctaText ?? 'OPEN LIVE DASHBOARD',
      )}</a></td></tr>`
    : '';
  const note = o.note
    ? `<tr><td colspan="2" style="padding-top:14px;color:#888;font-size:12px;line-height:1.5">${escapeHtml(
        o.note,
      )}</td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px">
<table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${o.headerColor};color:#fff;padding:18px 20px;font-size:18px;font-weight:700">${escapeHtml(
    o.headerText,
  )}</td></tr>
<tr><td style="padding:18px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}${cta}${note}</table></td></tr>
<tr><td style="padding:12px 20px;color:#aaa;font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-family:monospace">BLACK BOX · personal safety</td></tr>
</table></td></tr></table></body></html>`;
}

function coords(location: ActivationAlertPayload['location']): string {
  return location ? `${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°` : 'awaiting fix';
}

export function emailActivation(p: ActivationAlertPayload): BuiltEmail {
  const rows: Row[] = [
    ['Who', p.userDisplayName],
    ['Status', 'Live audio + location active'],
    p.location
      ? ['Where', `${coords(p.location)} — open map`, mapLink(p.location.lat, p.location.lon)]
      : ['Where', coords(p.location)],
  ];
  if (p.threatSummary) {
    rows.push(['Heard', p.threatSummary]);
  }
  // §5: emergency-services dispatchers get a CAD-ready structured summary link.
  if (p.summaryUrl) {
    rows.push(['Dispatch summary', 'CAD-ready summary — open', p.summaryUrl]);
  }
  return {
    subject: `🚨 BLACK BOX ALERT *** ${p.userDisplayName} *** BLACK BOX ALERT 🚨`,
    html: shell({
      headerColor: RED,
      headerText: '🚨 EMERGENCY',
      rows,
      ctaUrl: p.dashboardUrl,
      ctaText: 'OPEN LIVE DASHBOARD',
    }),
    text:
      `EMERGENCY — ${p.userDisplayName} activated BLACK BOX. Live audio + location active.\n` +
      `Where: ${coords(p.location)}\n${p.threatSummary ? `Heard: ${p.threatSummary}\n` : ''}` +
      `Open the live dashboard: ${p.dashboardUrl}\n` +
      `${p.summaryUrl ? `Emergency services — CAD dispatch summary: ${p.summaryUrl}\n` : ''}`,
  };
}

export function emailEscalation(p: EscalationAlertPayload): BuiltEmail {
  // A re-issued link (the prior link expired on an unresolved event) is its own
  // message: it carries a FRESH working link plus full provenance, so the
  // recipient knows exactly what they must resolve. The path never dead-ends.
  if (p.reason === 'link_reissued') {
    const pv = p.provenance;
    const rows: Row[] = [
      ['Who', p.userDisplayName],
      ['Status', 'ALERT STILL ACTIVE — NOBODY HAS SECURED IT YET'],
    ];
    if (pv?.triggeredByName || pv?.triggeredByEmail) {
      rows.push(['Triggered by', [pv.triggeredByName, pv.triggeredByEmail].filter(Boolean).join(' · ')]);
    }
    if (pv?.triggeredAt) {
      rows.push(['Triggered at', pv.triggeredAt]);
    }
    if (pv?.linkExpiredAt) {
      rows.push(['Old link expired', pv.linkExpiredAt]);
    }
    if (pv?.notifiedAt) {
      rows.push(['This notice sent', pv.notifiedAt]);
    }
    if (pv?.closerName || pv?.closerEmail) {
      rows.push(['Must confirm closure', [pv.closerName, pv.closerEmail].filter(Boolean).join(' · ')]);
    }
    return {
      subject: `🚨 BLACK BOX — ${p.userDisplayName} STILL NEEDS HELP — fresh link inside 🚨`,
      html: shell({
        headerColor: RED,
        headerText: '🚨 STILL ACTIVE — NEW LINK',
        rows,
        ctaUrl: p.dashboardUrl,
        ctaText: 'OPEN LIVE DASHBOARD (NEW LINK)',
        note: 'The earlier link expired and no one has secured this alert. This link is live now. The alert has NOT been cancelled — open it and confirm they are safe.',
      }),
      text:
        `STILL ACTIVE — ${p.userDisplayName}'s alert has not been secured. The earlier link expired; here is a fresh, working one.\n` +
        (pv?.triggeredByName || pv?.triggeredByEmail
          ? `Triggered by: ${[pv.triggeredByName, pv.triggeredByEmail].filter(Boolean).join(' · ')}\n`
          : '') +
        (pv?.triggeredAt ? `Triggered at: ${pv.triggeredAt}\n` : '') +
        (pv?.linkExpiredAt ? `Old link expired: ${pv.linkExpiredAt}\n` : '') +
        (pv?.notifiedAt ? `This notice sent: ${pv.notifiedAt}\n` : '') +
        (pv?.closerName || pv?.closerEmail
          ? `Must confirm closure: ${[pv.closerName, pv.closerEmail].filter(Boolean).join(' · ')}\n`
          : '') +
        `Open the live dashboard (new link): ${p.dashboardUrl}`,
    };
  }
  const why =
    p.reason === 'client_lost'
      ? `${p.userDisplayName}'s phone closed the app or lost connection while the alert was still active.`
      : `${p.userDisplayName}'s phone stopped checking in while the alert was still active (it may be off, out of battery, or taken).`;
  const rows: Row[] = [
    ['Who', p.userDisplayName],
    ['Status', 'ALERT STILL ACTIVE — device went dark'],
  ];
  if (p.lastSeen) {
    rows.push(['Last seen', p.lastSeen]);
  }
  if (p.location) {
    rows.push([
      'Last where',
      `${p.location.lat.toFixed(4)}°, ${p.location.lon.toFixed(4)}° — open map`,
      mapLink(p.location.lat, p.location.lon),
    ]);
  }
  return {
    subject: `🚨 BLACK BOX — ${p.userDisplayName}'s phone went dark — ALERT STILL ACTIVE 🚨`,
    html: shell({
      headerColor: RED,
      headerText: '🚨 DEVICE WENT DARK',
      rows,
      ctaUrl: p.dashboardUrl,
      ctaText: 'OPEN LIVE DASHBOARD',
      note: `${why} This is MORE urgent, not resolved. The alert has not been cancelled.`,
    }),
    text:
      `DEVICE WENT DARK — ${p.userDisplayName}'s phone stopped checking in. THE ALERT IS STILL ACTIVE.\n` +
      `${why}\n${p.lastSeen ? `Last seen: ${p.lastSeen}\n` : ''}` +
      `This is more urgent, not resolved. Open the live dashboard: ${p.dashboardUrl}`,
  };
}

export function emailClosureRequest(p: ClosureRequestPayload): BuiltEmail {
  return {
    subject: `BLACK BOX — Closure requested by ${p.userDisplayName}`,
    html: shell({
      headerColor: INK,
      headerText: 'CLOSURE REQUESTED',
      rows: [
        ['Who', p.userDisplayName],
        ['Action', 'Requested closure of the active session'],
      ],
      ctaUrl: p.dashboardUrl,
      ctaText: 'REVIEW ON THE DASHBOARD',
      note: 'Review the live dashboard before standing the alert down. Confirm they are safe.',
    }),
    text:
      `${p.userDisplayName} has requested closure of the active session.\n` +
      `Review the dashboard before standing it down: ${p.dashboardUrl}`,
  };
}

export function emailDuress(p: DuressAlertPayload): BuiltEmail {
  return {
    subject: `⚠ BLACK BOX DURESS — DO NOT APPROVE — ${p.userDisplayName} ⚠`,
    html: shell({
      headerColor: RED,
      headerText: '⚠ DURESS — DO NOT APPROVE',
      rows: [
        ['Who', p.userDisplayName],
        ['Signal', 'Entered their duress code — they are being forced to close the alert'],
      ],
      ctaUrl: p.dashboardUrl,
      ctaText: 'OPEN LIVE DASHBOARD',
      note: 'Recording continues regardless of any response. Call emergency services now. Do NOT stand the alert down.',
    }),
    text:
      `DURESS — ${p.userDisplayName} entered their duress code. They are being forced to close the alert.\n` +
      `Recording continues regardless. Call emergency services now. Do NOT stand it down.\n` +
      `Dashboard: ${p.dashboardUrl}`,
  };
}

export function emailClosureConfirmation(p: ClosureConfirmationPayload): BuiltEmail {
  return {
    subject: `BLACK BOX — Session closed — ${p.userDisplayName}`,
    html: shell({
      headerColor: INK,
      headerText: 'SESSION CLOSED',
      rows: [
        ['Who', p.userDisplayName],
        ['Status', 'Closure approved — recording has stopped'],
      ],
    }),
    text: `Closure approved for ${p.userDisplayName}. Recording has stopped and the session is closed.`,
  };
}

export function emailStandDownConfirmation(p: StandDownConfirmationPayload): BuiltEmail {
  return {
    subject: `BLACK BOX — Alert ended at ${p.time} — ${p.userDisplayName}`,
    html: shell({
      headerColor: INK,
      headerText: 'ALERT ENDED',
      rows: [
        ['Who', p.userDisplayName],
        ['Ended', p.time],
        ['Status', 'You stood the alert down — recording has stopped'],
      ],
    }),
    text: `You stood down the alert for ${p.userDisplayName} at ${p.time}. Recording has stopped and the session is closed.`,
  };
}

const CALM = '#34788a';
export function emailCheckin(p: CheckinPayload): BuiltEmail {
  const rows: Row[] = [
    ['Who', p.userDisplayName],
    ['Status', "I'm OK"],
    ['Time', p.time],
  ];
  if (p.location) {
    // A real, tappable map link — not bare coordinates (Brief 19).
    rows.push([
      'Shared location',
      `${p.location.lat.toFixed(4)}°, ${p.location.lon.toFixed(4)}° — open map`,
      mapLink(p.location.lat, p.location.lon),
    ]);
  }
  return {
    subject: `${p.userDisplayName} checked in — I'm OK`,
    html: shell({
      headerColor: CALM,
      headerText: '✓ Check-in',
      rows,
      note: 'A reassurance check-in. This is NOT an alert — no recording, no tracking.',
    }),
    text: `${p.userDisplayName} checked in — I'm OK at ${p.time}.${p.location ? ` Location: ${mapLink(p.location.lat, p.location.lon)}` : ''} (Reassurance only — not an alert.)`,
  };
}

export function emailClassificationUpdate(p: ClassificationUpdatePayload): BuiltEmail {
  return {
    subject: `BLACK BOX — Update (${p.threatLevel})`,
    html: shell({
      headerColor: RED,
      headerText: 'UPDATE',
      rows: [
        ['Summary', p.summary],
        ['Threat', p.threatLevel],
      ],
      ctaUrl: p.dashboardUrl,
      ctaText: 'OPEN LIVE DASHBOARD',
    }),
    text: `Update — ${p.summary} (threat: ${p.threatLevel}). Dashboard: ${p.dashboardUrl}`,
  };
}
