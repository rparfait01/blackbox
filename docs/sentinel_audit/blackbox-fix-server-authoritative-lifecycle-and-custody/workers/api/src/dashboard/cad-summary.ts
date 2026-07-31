/**
 * CAD-ready dispatch summary (Fix Brief 16 §5). The view the emergency services
 * tier receives when reached via the ESCALATION path — a structured, read-only
 * event summary organized for fast dispatch consumption, NOT the live dashboard
 * (that is the direct-share path). No closure or consent control of any kind.
 */

import { formatDtg } from '@blackbox/shared';
import type { ContactState } from '../lib/contact-state';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Decimal degrees → degrees/minutes/seconds with hemisphere — the format CAD
 *  and radio dispatch read aloud. */
function toDms(value: number, positive: string, negative: string): string {
  const hemi = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60).toFixed(1);
  return `${deg}°${min}'${sec}"${hemi}`;
}

function coordBlock(lat: number, lon: number, accuracyM: number | null): string {
  const dec = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const dms = `${toDms(lat, 'N', 'S')} ${toDms(lon, 'E', 'W')}`;
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
  const acc = accuracyM != null ? ` (±${Math.round(accuracyM)} m)` : '';
  return `<div class="coord"><div><b>Decimal:</b> ${dec}${acc}</div><div><b>DMS:</b> ${esc(dms)}</div><div><a href="${maps}" target="_blank" rel="noopener">Open on map</a></div></div>`;
}

export function renderCadSummary(opts: {
  eventId: string;
  subjectName: string;
  state: ContactState;
}): string {
  const { eventId, subjectName, state } = opts;
  const s = state;
  const dtg = formatDtg(s.startedAt);
  const threat = s.latestClassification?.threatLevel ?? s.situation?.threatLevel ?? 'unassessed';
  const cats = (s.situation?.categories ?? []).map((c) => c.category);
  const summary =
    s.latestClassification?.summary ??
    (cats.length ? `Detected: ${cats.join(', ')}` : null);
  const emerg = s.emergency;
  const voices = s.situation?.multipleVoicesInferred ? ' · multiple voices inferred' : '';

  const lastKnown = s.location
    ? coordBlock(s.location.lat, s.location.lon, s.location.accuracyM)
    : '<div class="muted">No location fix received.</div>';
  const origin =
    s.origin && s.origin.location
      ? `${coordBlock(s.origin.location.lat, s.origin.location.lon, s.origin.location.accuracyM)}<div class="muted">Trigger: ${esc(s.origin.triggerType)} · DTG ${esc(formatDtg(s.origin.dtgStart))}</div>`
      : '<div class="muted">No frozen origin snapshot.</div>';

  const resources = emerg
    ? `<div><b>Police:</b> ${esc(emerg.police)} &nbsp; <b>Ambulance:</b> ${esc(emerg.ambulance)}</div>`
    : '<div class="muted">Region unknown — use local emergency dispatch.</div>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>BLACK BOX — Dispatch Summary</title>
<style>
  body{margin:0;background:#0b0b0b;color:#e8e8e8;font-family:"IBM Plex Sans",system-ui,sans-serif;line-height:1.5;padding:16px}
  h1{font-size:16px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px}
  .tag{display:inline-block;background:#3a0d0d;color:#ff8f88;border:1px solid #ff3b30;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:.08em}
  section{border:1px solid #222;border-radius:10px;padding:12px 14px;margin:12px 0;background:#111}
  .label{font-family:"IBM Plex Mono",monospace;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:6px}
  .coord{font-family:"IBM Plex Mono",monospace;font-size:13px}
  .coord a{color:#7db1ff}
  .muted{color:#888;font-size:13px}
  .big{font-size:15px;font-weight:600}
  .note{font-size:12px;color:#aaa;margin-top:14px}
</style></head><body>
  <h1>Dispatch Summary <span class="tag">NOTIFICATION ONLY</span></h1>
  <div class="muted">Emergency services are notified for awareness. This summary carries no closure or consent control.</div>

  <section><div class="label">Subject</div><div class="big">${esc(subjectName || 'Unknown subject')}</div>
    <div class="muted">Event ${esc(eventId)} · Activated DTG ${esc(dtg)} · ${s.active ? 'ACTIVE' : 'ended'}${s.deviceDark ? ' · DEVICE DARK' : ''}</div></section>

  <section><div class="label">Threat read</div><div class="big">${esc(String(threat).toUpperCase())}${esc(voices)}</div>
    ${summary ? `<div class="muted">${esc(summary)}</div>` : ''}</section>

  <section><div class="label">Last known location</div>${lastKnown}</section>
  <section><div class="label">Frozen origin (initial contact)</div>${origin}</section>
  <section><div class="label">Nearest resources</div>${resources}</section>
  <section><div class="label">Witness callback</div>
    <div class="muted">Live coordination is held by the subject's support contact on the BLACK BOX dashboard. Callbacks and updates route through that coordinator.</div></section>

  <div class="note">Generated by BLACK BOX. Read-only. Access is logged. This link expires after the event.</div>
</body></html>`;
}
