/**
 * Contact dashboard page (W7), served by the Worker at GET /c/:id. This is the
 * contact's surface — on their own device, away from any threat — so it is the
 * opposite of the user's covert phone: loud, urgent, immediate.
 *
 * The page is self-contained: inline CSS + inline client JS, no third-party
 * fonts or CDN scripts. The map uses OpenStreetMap raster tiles rendered by a
 * tiny self-written slippy map (no Leaflet/Google dependency to pull from a
 * CDN). The location pin is server-side rendered so it works with JS disabled;
 * audio + live updates require JS.
 */

import { formatDtg, formatLocalClock } from '@blackbox/shared';
import type { ContactState } from '../lib/contact-state';

/** Which role-scoped view to render (Fix Brief 3). */
export type DashboardRole = 'coordinator' | 'dispatch';

interface DashboardOpts {
  eventId: string;
  token: string;
  base: string;
  state: ContactState;
  /** coordinator (guardian live view) or dispatch (authority/CAD). */
  role?: DashboardRole;
  /** The verified recipient viewing this evidence (Fix Brief 2 #C1; dispatch). */
  recipient?: { id: string; fullName: string; agency: string };
}

const ZOOM = 16;
const TILE = 'https://tile.openstreetmap.org';

function lon2tile(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function lat2tile(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SSR location pin: one OSM tile with the pin at the fractional pixel. */
function ssrMap(state: ContactState): string {
  const loc = state.location;
  if (!loc) {
    return '<div class="map-empty">Awaiting first location fix…</div>';
  }
  const tx = lon2tile(loc.lon, ZOOM);
  const ty = lat2tile(loc.lat, ZOOM);
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  const px = Math.round((tx - x) * 256);
  const py = Math.round((ty - y) * 256);
  const osm = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=16/${loc.lat}/${loc.lon}`;
  return (
    `<a class="ssr-tile" href="${osm}" target="_blank" rel="noopener noreferrer">` +
    `<img src="${TILE}/${ZOOM}/${x}/${y}.png" width="256" height="256" alt="map" loading="lazy" />` +
    `<span class="ssr-pin" style="left:${px}px;top:${py}px"></span>` +
    `</a>`
  );
}

function transcriptHtml(state: ContactState): string {
  if (state.latestTranscriptFragments.length === 0) {
    return '<div class="muted">Listening…</div>';
  }
  return state.latestTranscriptFragments
    .map((f) => `<div class="tline">${escapeHtml(f.text)}</div>`)
    .join('');
}

function clock(ms: number): string {
  // Roll over to hh:mm:ss past an hour so a long session never reads as a
  // runaway minute count like "2188:56" (Brief 12 P3).
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// Published category labels — mirrors the classifier's rule set so the rendered
// situation is auditable (Fix Brief 5 D2).
const CATEGORY_LABEL: Record<string, string> = {
  weapon: 'Weapon reference',
  violence: 'Violence language',
  restraint: 'Restraint language',
  compliance: 'Coercion / compliance',
  fear: 'Fear expressed',
  pain: 'Pain expressed',
  medical: 'Medical distress',
  disorientation: 'Disorientation',
  bargaining: 'Bargaining',
  'profanity-distress': 'Distress profanity',
};
function catLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c;
}
function threatClass(level: string): string {
  return level === 'critical' || level === 'high' ? 'th-high' : level === 'medium' ? 'th-med' : 'th-low';
}
const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Manual activation',
  deadman: 'Deadman (released)',
  tamper: 'Tamper',
};

/** Frozen ORIGIN block — the immutable initial-contact anchor (Fix Brief 5 D1). */
function originHtml(state: ContactState): string {
  const o = state.origin;
  if (!o) {
    return '<div class="muted">Capturing initial-contact snapshot…</div>';
  }
  const rows: Array<[string, string]> = [
    ['Trigger', TRIGGER_LABEL[o.triggerType] ?? o.triggerType],
    ['Start (DTG)', formatDtg(o.dtgStart)],
  ];
  if (o.location) {
    rows.push(['Where', `${o.location.lat.toFixed(4)}°, ${o.location.lon.toFixed(4)}°`]);
  }
  if (o.voiceCount != null) {
    rows.push(['Voices at start', o.voiceCount > 1 ? `${o.voiceCount} (inferred)` : String(o.voiceCount)]);
  }
  if (o.categories.length > 0) {
    rows.push(['Initial signals', o.categories.map(catLabel).join(', ')]);
  }
  if (o.audioFromSeq != null) {
    rows.push(['First audio', `segments ${o.audioFromSeq}–${o.audioToSeq ?? o.audioFromSeq}`]);
  }
  return rows
    .map(
      ([k, v]) =>
        `<div class="kv"><span class="kv-k">${escapeHtml(k)}</span><span class="kv-v">${escapeHtml(v)}</span></div>`,
    )
    .join('');
}

/**
 * SITUATION block — latched, assembled detected facts + rule-derived threat
 * (Fix Brief 5 D2/D3). No free-text generation; inferences are marked. Mirrored
 * by the client poll renderer (window.__renderSituation).
 */
function situationHtml(s: ContactState['situation']): string {
  if (!s.hasSignal) {
    return '<div class="muted">No specific indicators detected yet. Audio + location active.</div>';
  }
  const parts: string[] = [];
  parts.push(
    `<div class="th-row"><span class="kv-k">Threat (rule-derived)</span><span class="th-badge ${threatClass(
      s.threatLevel,
    )}">${escapeHtml(s.threatLevel.toUpperCase())}</span></div>`,
  );
  if (s.categories.length > 0) {
    parts.push(
      `<div class="facts">${s.categories
        .map((c) => `<span class="fact">${escapeHtml(catLabel(c.category))}</span>`)
        .join('')}</div>`,
    );
  }
  if (s.toneIndicators.length > 0) {
    parts.push(
      `<div class="facts">${s.toneIndicators
        .map((t) => `<span class="fact fact-tone">${escapeHtml(t.replace(/-/g, ' '))}</span>`)
        .join('')}</div>`,
    );
  }
  if (s.multipleVoicesInferred) {
    parts.push('<div class="inferred">Multiple voices detected — inferred, low confidence</div>');
  }
  return parts.join('');
}

/** Status banner copy + class (Fix Brief 3 R2). */
function statusBanner(state: ContactState): { text: string; cls: string } {
  if (!state.active) {
    return { text: 'SESSION ENDED', cls: 'sb-ended' };
  }
  if (state.deviceDark) {
    return { text: 'DEVICE WENT DARK — ALERT STILL ACTIVE', cls: 'sb-dark' };
  }
  return { text: 'ACTIVE', cls: 'sb-active' };
}

/** Escalation timeline line: started DTG + device-dark local time if any. */
function timeline(state: ContactState): string {
  const parts = [`Started ${formatDtg(state.startedAt)}`];
  if (state.escalatedAt) {
    parts.push(`device dark ${formatLocalClock(state.escalatedAt, state.tzOffsetMinutes)}`);
  } else if (state.lostAt) {
    parts.push(`client lost ${formatLocalClock(state.lostAt, state.tzOffsetMinutes)}`);
  }
  return parts.join(' · ');
}

export function renderDashboardPage(opts: DashboardOpts): string {
  const { eventId, token, base, state, recipient } = opts;
  const role: DashboardRole = opts.role ?? 'coordinator';
  const cfg = {
    eventId,
    token,
    base,
    zoom: ZOOM,
    tile: TILE,
    emergency: state.emergency,
  };
  const banner = statusBanner(state);
  const recording = state.active
    ? '<span class="dot"></span><span class="rec-text">Recording</span>'
    : '<span class="rec-text ended">Session ended</span>';

  // NOTE: CLIENT_JS contains NO backticks and NO "${" so it is safe inside this
  // template literal. Config + initial state are injected as JSON below.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<title>BLACK BOX · Live</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="brand">${role === 'dispatch' ? 'BLACK BOX · DISPATCH (CAD)' : 'BLACK BOX · Live'}</div>
  <div class="status-banner ${banner.cls}">${banner.text}</div>
  <div class="dtg">INITIAL REPORT · ${formatDtg(state.startedAt)}</div>
  <div class="timeline">${timeline(state)}</div>
  ${
    recipient
      ? `<div class="rcp">Accessed by ${escapeHtml(recipient.fullName)} · ${escapeHtml(
          recipient.agency,
        )} · ${escapeHtml(recipient.id)}</div>`
      : ''
  }

  ${role === 'coordinator' ? '<div class="closure-window" id="closureWindow" style="display:none"></div>' : ''}

  <div class="bar">
    <div class="rec" id="rec">${recording}</div>
    <div class="elapsed" id="elapsed">${clock(state.durationMs)}</div>
  </div>

  <!-- Fix Brief 8: the live map leads the coordinator view. Then
       ORIGIN → SITUATION → CAMERA → TRANSCRIPT(secondary) → audio/devices. -->
  <section class="sec">
    <div class="label">Location · Live</div>
    <div class="map" id="map">${ssrMap(state)}</div>
    <div class="coords" id="coords">${
      state.location
        ? `${state.location.lat.toFixed(4)}°, ${state.location.lon.toFixed(4)}°`
        : '—'
    }</div>
    <div class="coords-meta" id="coordsMeta">${
      state.location?.accuracyM != null ? `±${Math.round(state.location.accuracyM)}m` : ''
    }</div>
  </section>

  <section class="sec sec-origin">
    <div class="label">Origin · Frozen at activation</div>
    <div id="origin">${originHtml(state)}</div>
  </section>

  <section class="sec sec-situation">
    <div class="label">Situation · Detected facts (latched)</div>
    <div id="situation">${situationHtml(state.situation)}</div>
  </section>

  <section class="sec sec-camera">
    <div class="label">Live camera</div>
    ${
      state.hasVideo
        ? '<video id="cam" class="camera" controls playsinline></video><button id="camReload" class="cam-reload">↻ Refresh feed</button>'
        : '<div class="map-empty">No camera feed — audio-only capture.</div>'
    }
  </section>

  <section class="sec sec-transcript">
    <div class="label">Live transcript · secondary (evidence/replay)</div>
    <div class="transcript transcript-secondary" id="transcript">${transcriptHtml(state)}</div>
  </section>

  <section class="sec">
    <div class="label">Audio · Live</div>
    <audio id="audio" class="audio" preload="auto"></audio>
    <button id="audioStart" class="audio-start" hidden>Tap to start audio</button>
    <div class="muted" id="audioNote"></div>
  </section>

  <section class="sec">
    <div class="label">Capture source</div>
    <div class="muted">${state.hasVideo ? 'Phone microphone &amp; camera' : 'Phone microphone'} · no external hardware paired</div>
  </section>

  <div class="actions">
    ${
      role === 'coordinator'
        ? '<button id="shareAuth" class="btn btn-share">SHARE WITH AUTHORITIES</button>'
        : ''
    }
    ${
      role === 'dispatch'
        ? '<button id="exportPkg" class="btn btn-share">EXPORT EVIDENCE PACKAGE</button>'
        : ''
    }
    <a id="call" class="btn btn-call" href="tel:${state.emergency.police}">CALL EMERGENCY (${state.emergency.police})</a>
    ${
      role === 'coordinator' && state.active
        ? '<button id="secureAlert" class="btn btn-secure">SECURE — END ALERT</button>'
        : ''
    }
  </div>

  <div class="ended-banner" id="endedBanner" ${state.active ? 'hidden' : ''}>
    Session ended — recording has stopped.
  </div>

  <!-- Share-with-authorities modal (Fix Brief 4 G1): QR + dispatch link. -->
  <div class="modal" id="dispatchModal">
    <div class="modal-card">
      <div class="modal-title">Share with authorities</div>
      <div class="qr-box" id="dispatchQr"></div>
      <div class="modal-note">Scan the code or open the link on the responder's device. They must verify their identity before any evidence is shown.</div>
      <input class="modal-url" id="dispatchUrl" readonly />
      <button class="btn btn-share" id="dispatchCopy">Copy link</button>
      <button class="modal-close" id="dispatchClose">Close</button>
    </div>
  </div>
</main>
<script>window.__CFG=${JSON.stringify(cfg)};window.__STATE0=${JSON.stringify(state)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Notified (limited) view (Fix Brief 3 R1/R2) — for guardians who open the link
 * after the coordinator has been claimed. Status only; no live media, no actions
 * beyond calling emergency services.
 */
export function renderNotifiedPage(opts: {
  eventId: string;
  base: string;
  state: ContactState;
  /** Show the "Take coordination" button (no coordinator claimed yet). */
  claimable?: boolean;
}): string {
  const { eventId, base, state, claimable } = opts;
  const banner = statusBanner(state);
  // Location-only tier (Brief 9): the network sees the live MAP only — never
  // audio/video. The page makes no /audio calls, so distressing capture never
  // spreads across devices.
  const cfg = { eventId, base, zoom: ZOOM, tile: TILE };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<title>BLACK BOX · Alert</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="brand">BLACK BOX · Alert · location only</div>
  <div class="status-banner ${banner.cls}">${banner.text}</div>
  <div class="dtg">INITIAL REPORT · ${formatDtg(state.startedAt)}</div>
  <div class="timeline">${timeline(state)}</div>

  <section class="sec">
    <div class="label">Location · Live</div>
    <div class="map" id="map">${ssrMap(state)}</div>
    <div class="coords" id="coords">${
      state.location
        ? `${state.location.lat.toFixed(4)}°, ${state.location.lon.toFixed(4)}°`
        : '—'
    }</div>
  </section>

  <section class="sec">
    <div class="muted" style="font-size:13px;line-height:1.5">
      ${
        claimable
          ? 'You can take coordination of this alert — you would then get live audio and the actions. Only do so if you are able to respond.'
          : "A coordinator is handling this alert. You're in the network's location-only view — audio and actions are with the coordinator. If you can't reach them and believe someone is in danger, call emergency services now."
      }
    </div>
  </section>

  <div class="actions">
    ${claimable ? '<button id="takeCoord" class="btn btn-respond">TAKE COORDINATION</button>' : ''}
    <a class="btn btn-call" href="tel:${state.emergency.police}">CALL EMERGENCY (${state.emergency.police})</a>
  </div>
</main>
<script>window.__CFG=${JSON.stringify(cfg)};</script>
<script>${NOTIFIED_JS}</script>
</body>
</html>`;
}

// Location-only poll for the notified view — refreshes coordinates every 5s.
// Deliberately fetches NOTHING but /state.location (no audio).
const NOTIFIED_JS = `
(function(){
  var CFG=window.__CFG;
  function poll(){
    fetch(CFG.base+'/v1/c/'+CFG.eventId+'/state'+location.search).then(function(r){return r.ok?r.json():null;}).then(function(st){
      if(st&&st.location){ var c=document.getElementById('coords'); if(c){ c.textContent=st.location.lat.toFixed(4)+'°, '+st.location.lon.toFixed(4)+'°'; } }
    }).catch(function(){});
  }
  setInterval(poll,5000);
  // Take coordination: deliberate claim, then reload into the full coordinator view.
  var tc=document.getElementById('takeCoord');
  if(tc){ tc.onclick=function(){
    tc.disabled=true; tc.textContent='CLAIMING…';
    fetch(CFG.base+'/v1/c/'+CFG.eventId+'/claim-coordinator'+location.search,{method:'POST'})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); }).then(function(res){
        if(res.ok && res.d && res.d.claimed){ window.location.reload(); }
        else { tc.disabled=false; tc.textContent='TAKE COORDINATION'; alert('Another responder has already taken coordination.'); }
      }).catch(function(){ tc.disabled=false; tc.textContent='TAKE COORDINATION'; });
  };}
})();
`;

export function renderTokenPage(kind: 'expired' | 'invalid'): string {
  const heading = kind === 'expired' ? 'This live link has expired' : 'This link is not valid';
  const body =
    kind === 'expired'
      ? 'Live links are active for one hour. Check LINE for the most recent alert message and open the dashboard link there.'
      : 'The link may be incomplete or mistyped. Open the dashboard from the link in the LINE alert message.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BLACK BOX</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap expired">
  <div class="brand">BLACK BOX</div>
  <h1>${heading}</h1>
  <p>${body}</p>
</main>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#e8e8e8;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:520px;margin:0 auto;padding:16px 16px 48px}
.brand{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:4px}
.dtg{font-family:ui-monospace,Menlo,monospace;font-size:13px;letter-spacing:.1em;color:#e8e8e8;margin-bottom:4px}
.timeline{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.04em;color:#888;margin-bottom:8px}
.rcp{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.04em;color:#666;margin-bottom:8px}
.status-banner{margin:6px 0;padding:10px 12px;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700;letter-spacing:.08em;text-align:center}
.sb-active{background:#13301a;color:#34c759}
.sb-dark{background:#3a1414;color:#ff6b60;animation:pulse 1.2s infinite}
.sb-ended{background:#1a1a1a;color:#888}
.sec-origin{border-left:3px solid #555;padding-left:12px}
.sec-situation{border-left:3px solid #ff3b30;padding-left:12px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.kv-k{color:#888;font-size:11px;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em}
.kv-v{color:#e8e8e8;font-size:14px;text-align:right}
.th-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.th-badge{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:5px}
.th-high{background:#3a1414;color:#ff6b60}
.th-med{background:#3a2e14;color:#e8a33d}
.th-low{background:#1a1a1a;color:#888}
.facts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.fact{background:#2a1414;color:#ff8b80;border:1px solid #5a2020;border-radius:5px;padding:3px 8px;font-size:12px}
.fact-tone{background:#14202a;color:#80b0d0;border-color:#204050}
.inferred{margin-top:8px;color:#999;font-size:12px;font-style:italic}
.camera{width:100%;border-radius:6px;background:#000;max-height:320px}
.cam-reload{margin-top:6px;background:#1a1a1a;color:#e8e8e8;border:1px solid #333;border-radius:6px;padding:8px 12px;font-size:12px}
.sec-transcript{opacity:.72}
.transcript-secondary{max-height:140px;font-size:12px;color:#aaa}
/* Hidden by default; shown only when JS adds .open (an explicit class beats the
   UA [hidden] rule that a bare .modal{display:flex} was overriding). */
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);align-items:center;justify-content:center;padding:20px;z-index:100}
.modal.open{display:flex}
.closure-window{border:2px solid #34c759;border-radius:10px;padding:14px;margin:8px 0}
.closure-window.duress{border-color:#ff3b30}
.cw-title{font-weight:700;font-size:15px;margin-bottom:8px}
.cw-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:14px}
.cw-ok{color:#34c759;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.cw-bad{color:#ff6b60;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.cw-warn{background:#3a1414;color:#ff6b60;border-radius:6px;padding:8px;font-size:12px;font-weight:700;margin:8px 0}
.cw-reason{color:#cfcfcf;font-size:13px;margin:8px 0;line-height:1.4}
.modal-card{background:#111;border:1px solid #333;border-radius:12px;padding:20px;max-width:360px;width:100%;text-align:center}
.modal-title{font-weight:700;font-size:16px;margin-bottom:14px}
.qr-box{background:#fff;border-radius:8px;padding:12px;display:inline-block;max-width:240px}
.qr-box svg{display:block;width:100%;height:auto}
.modal-note{color:#aaa;font-size:12px;line-height:1.5;margin:12px 0}
.modal-url{width:100%;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#cfcfcf;font-size:11px;padding:8px;margin-bottom:10px;font-family:ui-monospace,Menlo,monospace}
.modal-close{margin-top:10px;background:none;border:0;color:#888;font-size:13px;text-decoration:underline}
.bar{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #222;padding:10px 0}
.rec{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.rec-text{color:#ff3b30}
.rec-text.ended{color:#888}
.dot{width:9px;height:9px;border-radius:50%;background:#ff3b30;box-shadow:0 0 8px #ff3b30;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.elapsed{font-family:ui-monospace,Menlo,monospace;font-size:20px;letter-spacing:.04em}
.sec{border-bottom:1px solid #222;padding:14px 0}
.label{font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:8px}
.map{position:relative;width:100%;height:230px;border:1px solid #333;border-radius:6px;overflow:hidden;background:#0a1f1a}
.map-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px}
.ssr-tile{display:block;position:relative;width:256px;height:256px;margin:0 auto}
.ssr-pin,.live-pin{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 5px rgba(255,59,48,.3),0 0 14px #ff3b30}
.tile-layer{position:absolute;inset:0;overflow:hidden}
.tile-layer img{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none}
.coords{margin-top:8px;font-family:ui-monospace,Menlo,monospace;font-size:14px}
.coords-meta{margin-top:2px;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#888}
.audio{width:100%;margin-top:2px}
.audio-start{width:100%;padding:14px;margin-top:6px;border:0;border-radius:6px;background:#ff3b30;color:#fff;font-weight:700;font-size:15px;letter-spacing:.04em}
.transcript{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto}
.tline{font-size:14px;line-height:1.4}
.tline.hit{color:#ff6b60}
.summary{font-size:14px;line-height:1.5}
.threat-row{display:flex;justify-content:space-between;margin-top:8px}
.muted,.muted-label{color:#888;font-size:12px}
.muted-label{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.threat-val{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ff3b30}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:18px}
.btn{display:block;width:100%;text-align:center;padding:16px;border:0;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:.04em;text-decoration:none;cursor:pointer}
.btn-respond{background:#ff3b30;color:#fff;box-shadow:0 0 24px rgba(255,59,48,.35)}
.btn-respond.done{background:#1a3a1f;color:#34c759;box-shadow:none}
.btn-share{background:#1a1a1a;color:#e8e8e8;border:1px solid #333}
.btn-call{background:#111;color:#ff3b30;border:1px solid #ff3b30}
.btn-secure{background:#13301a;color:#34c759;border:1px solid rgba(52,199,89,.45)}
.btn-secure:disabled{opacity:.6}
.ended-banner{margin-top:18px;padding:14px;border:1px solid #333;border-radius:6px;text-align:center;color:#888;font-size:13px}
.expired{text-align:center;padding-top:80px}
.expired h1{font-size:22px;font-weight:600;margin-bottom:12px}
.expired p{color:#888;font-size:14px;line-height:1.6;max-width:42ch;margin:0 auto}
`;

// Inline client. Plain ES5-ish JS — NO backticks, NO "${" — so it embeds safely
// in the page template literal above. Reads window.__CFG and window.__STATE0.
const CLIENT_JS = `
(function(){
  var CFG=window.__CFG, S=window.__STATE0;
  var base=CFG.base, q='?t='+encodeURIComponent(CFG.token);
  function api(path){return base+'/v1/c/'+CFG.eventId+path+q;}
  function el(id){return document.getElementById(id);}

  // ---- elapsed ticker ----
  var startedAt=S.startedAt, active=S.active, durationMs=S.durationMs, baseNow=Date.now();
  function fmt(ms){var t=Math.max(0,Math.floor(ms/1000));var h=Math.floor(t/3600);var m=Math.floor((t%3600)/60);var s=t%60;function p(n){return (n<10?'0':'')+n;}return h>0?(p(h)+':'+p(m)+':'+p(s)):(p(m)+':'+p(s));}
  setInterval(function(){ if(active){ el('elapsed').textContent=fmt(durationMs+(Date.now()-baseNow)); } },1000);

  // ---- self-rendered OSM slippy map ----
  var Z=CFG.zoom, W=0, H=0, mapEl=el('map'), layer=null, pin=null, trailSvg=null;
  function lon2t(lon){return (lon+180)/360*Math.pow(2,Z);}
  function lat2t(lat){var r=lat*Math.PI/180;return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,Z);}
  function buildMap(){
    mapEl.innerHTML='';
    layer=document.createElement('div'); layer.className='tile-layer'; mapEl.appendChild(layer);
    trailSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    trailSvg.setAttribute('style','position:absolute;inset:0;width:100%;height:100%;pointer-events:none');
    mapEl.appendChild(trailSvg);
    pin=document.createElement('span'); pin.className='live-pin';
    pin.style.left='50%'; pin.style.top='50%'; mapEl.appendChild(pin);
  }
  function renderMap(loc, trail){
    if(!loc) return;
    W=mapEl.clientWidth; H=mapEl.clientHeight;
    var cx=lon2t(loc.lon), cy=lat2t(loc.lat);
    // center tile pixel position
    var centerPxX=W/2, centerPxY=H/2;
    layer.innerHTML='';
    var tilesX=Math.ceil(W/256)+2, tilesY=Math.ceil(H/256)+2;
    var x0=Math.floor(cx)-Math.floor(tilesX/2), y0=Math.floor(cy)-Math.floor(tilesY/2);
    for(var i=0;i<tilesX;i++){
      for(var j=0;j<tilesY;j++){
        var tx=x0+i, ty=y0+j;
        var img=document.createElement('img');
        img.src=CFG.tile+'/'+Z+'/'+tx+'/'+ty+'.png'; img.loading='lazy';
        var left=centerPxX+(tx-cx)*256;
        var top=centerPxY+(ty-cy)*256;
        img.style.left=left+'px'; img.style.top=top+'px';
        layer.appendChild(img);
      }
    }
    // trail polyline
    if(trail && trail.length>1){
      var pts='';
      for(var k=0;k<trail.length;k++){
        var px=centerPxX+(lon2t(trail[k].lon)-cx)*256;
        var py=centerPxY+(lat2t(trail[k].lat)-cy)*256;
        pts+=px+','+py+' ';
      }
      trailSvg.innerHTML='<polyline points="'+pts+'" fill="none" stroke="#ff3b30" stroke-opacity="0.6" stroke-width="2" stroke-dasharray="4 4"/>';
    } else { trailSvg.innerHTML=''; }
  }
  buildMap();
  function applyLocation(loc, trail){
    if(!loc) return;
    renderMap(loc, trail);
    el('coords').textContent=loc.lat.toFixed(4)+'°, '+loc.lon.toFixed(4)+'°';
    var meta='';
    if(loc.accuracyM!=null) meta='±'+Math.round(loc.accuracyM)+'m';
    if(loc.speed!=null && loc.speed>1.3) meta+=' · MOVING · '+loc.speed.toFixed(1)+' m/s';
    el('coordsMeta').textContent=meta;
  }
  if(S.location) applyLocation(S.location, S.trail);
  window.addEventListener('resize',function(){ if(lastLoc) renderMap(lastLoc,lastTrail); });
  var lastLoc=S.location, lastTrail=S.trail;

  // ---- transcript + classification (driven by /state poll) ----
  function applyTranscript(frags){
    if(!frags||!frags.length) return;
    var box=el('transcript'); box.innerHTML='';
    for(var i=0;i<frags.length;i++){
      var d=document.createElement('div'); d.className='tline'; d.textContent=frags[i].text; box.appendChild(d);
    }
  }
  // Latched situation renderer (Fix Brief 5 D2/D3) — assembled detected facts,
  // monotonic threat, inferences marked. Mirrors the server situationHtml().
  var SIT_LBL={weapon:'Weapon reference',violence:'Violence language',restraint:'Restraint language',compliance:'Coercion / compliance',fear:'Fear expressed',pain:'Pain expressed',medical:'Medical distress',disorientation:'Disorientation',bargaining:'Bargaining','profanity-distress':'Distress profanity'};
  function sitEsc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function applySituation(s){
    var node=el('situation'); if(!node||!s) return;
    if(!s.hasSignal){ node.innerHTML='<div class="muted">No specific indicators detected yet. Audio + location active.</div>'; return; }
    var lvl=s.threatLevel||'unknown';
    var thc=(lvl==='critical'||lvl==='high')?'th-high':(lvl==='medium'?'th-med':'th-low');
    var html='<div class="th-row"><span class="kv-k">Threat (rule-derived)</span><span class="th-badge '+thc+'">'+sitEsc(lvl.toUpperCase())+'</span></div>';
    if(s.categories&&s.categories.length){ html+='<div class="facts">'; for(var i=0;i<s.categories.length;i++){ var c=s.categories[i].category; html+='<span class="fact">'+sitEsc(SIT_LBL[c]||c)+'</span>'; } html+='</div>'; }
    if(s.toneIndicators&&s.toneIndicators.length){ html+='<div class="facts">'; for(var j=0;j<s.toneIndicators.length;j++){ html+='<span class="fact fact-tone">'+sitEsc(String(s.toneIndicators[j]).replace(/-/g,' '))+'</span>'; } html+='</div>'; }
    if(s.multipleVoicesInferred){ html+='<div class="inferred">Multiple voices detected — inferred, low confidence</div>'; }
    node.innerHTML=html;
  }
  applyTranscript(S.latestTranscriptFragments);
  applySituation(S.situation);

  // Coordinator closure window (Brief 9 Phase D): shows the user's closure
  // request — PIN sat/unsat (duress unmistakable), reason — and the SECURE
  // action with an explicit "are you sure" confirmation.
  function applyClosure(cl){
    var w=el('closureWindow'); if(!w) return;
    if(!cl || !cl.requested){ w.style.display='none'; w.innerHTML=''; return; }
    var duress = cl.pin==='unsat';
    w.style.display='block';
    w.className = duress ? 'closure-window duress' : 'closure-window';
    var html='<div class="cw-title">Closure requested by the user</div>';
    html+='<div class="cw-row"><span>PIN</span><span class="'+(duress?'cw-bad':'cw-ok')+'">'+(duress?'UNSAT · DURESS':'SAT')+'</span></div>';
    if(duress){ html+='<div class="cw-warn">THREAT ONGOING — do not assume safe. Validate that the user is genuinely safe before securing.</div>'; }
    if(cl.reasonSecured){ html+='<div class="cw-reason">Reason for securing: '+sitEsc(cl.reasonSecured)+'</div>'; }
    // Status only — the coordinator secures via the single SECURE control below
    // (the confirm step), seeing PIN sat/unsat. They never enter the pin.
    html+='<div class="cw-reason">Review, then use <b>SECURE — END ALERT</b> below to confirm. You never enter a pin.</div>';
    w.innerHTML=html;
  }
  applyClosure(S.closure);

  // ---- live camera (replays captured video feed; prominent when present) ----
  (function(){
    var cam=el('cam'); if(!cam) return;
    function load(){ cam.src=api('/audio/full'); }
    load();
    var rb=el('camReload'); if(rb){ rb.onclick=load; }
  })();

  // ---- progressive audio (MSE) with /audio/full fallback ----
  var audio=el('audio'), note=el('audioNote'), startBtn=el('audioStart');
  var knownLatest=S.audio.latestSequence, mime=S.audio.mimeType;
  function normMime(m){ if(!m) return ''; if(m.indexOf('audio/mp4')===0) return 'audio/mp4; codecs="mp4a.40.2"'; if(m.indexOf('audio/webm')===0) return 'audio/webm; codecs="opus"'; if(m.indexOf('video/webm')===0) return 'video/webm; codecs="vp8,opus"'; return m; }
  function tryAutoplay(){ var p=audio.play(); if(p&&p.catch){ p.catch(function(){ startBtn.hidden=false; startBtn.onclick=function(){ audio.play(); startBtn.hidden=true; }; }); } }
  var useMse=false, nm=normMime(mime);
  if(knownLatest!=null && window.MediaSource && nm && window.MediaSource.isTypeSupported(nm)){
    useMse=true;
    var ms=new MediaSource(); audio.src=URL.createObjectURL(ms);
    var sb=null, nextSeq=0, queue=[], fetching=false;
    ms.addEventListener('sourceopen',function(){ sb=ms.addSourceBuffer(nm); sb.addEventListener('updateend',pump); pumpFetch(); });
    function pump(){ if(sb && !sb.updating && queue.length){ try{ sb.appendBuffer(queue.shift()); }catch(e){} } catchUp(); }
    function catchUp(){ try{ if(audio.buffered.length){ var end=audio.buffered.end(audio.buffered.length-1); if(end-audio.currentTime>6){ audio.currentTime=end-2; } } }catch(e){} }
    function pumpFetch(){
      if(fetching) return;
      if(knownLatest==null || nextSeq>knownLatest){ return; }
      fetching=true;
      fetch(api('/audio/'+nextSeq)).then(function(r){ return r.ok?r.arrayBuffer():null; }).then(function(buf){
        fetching=false;
        if(buf){ queue.push(new Uint8Array(buf)); nextSeq++; pump(); }
        pumpFetch();
      }).catch(function(){ fetching=false; });
    }
    window.__pumpAudio=function(latest){ if(latest!=null){ knownLatest=latest; } pumpFetch(); };
    tryAutoplay();
    note.textContent='Live audio · streaming';
  } else if(knownLatest!=null){
    audio.controls=true; audio.src=api('/audio/full');
    note.textContent='Live audio · press play (progressive streaming unavailable in this browser)';
    tryAutoplay();
    window.__pumpAudio=function(){};
  } else {
    note.textContent='No audio captured yet…';
    window.__pumpAudio=function(latest){
      if(latest!=null && !useMse){ /* first audio arrived; reload page-light */ }
    };
  }

  // ---- session-ended handling ----
  function applyStatus(st){
    if(st.active===false && active){
      active=false;
      el('rec').innerHTML='<span class="rec-text ended">Session ended</span>';
      el('endedBanner').hidden=false;
      var sa=el('secureAlert'); if(sa){ sa.style.display='none'; }
    }
  }

  // ---- /state polling backbone (every 3s) ----
  function poll(){
    fetch(api('/state')).then(function(r){ return r.ok?r.json():null; }).then(function(st){
      if(!st) return;
      durationMs=st.durationMs; baseNow=Date.now();
      if(st.location){ lastLoc=st.location; lastTrail=st.trail; applyLocation(st.location, st.trail); }
      applyTranscript(st.latestTranscriptFragments);
      applySituation(st.situation);
      applyClosure(st.closure);
      if(st.audio){ if(window.__pumpAudio) window.__pumpAudio(st.audio.latestSequence); }
      applyStatus(st);
    }).catch(function(){});
  }
  var pollTimer=setInterval(poll,3000);

  // ---- SSE enhancement (lower latency); polling remains the guarantee ----
  try{
    var es1=new EventSource(api('/audio/stream'));
    es1.onmessage=function(e){ try{ var d=JSON.parse(e.data); if(window.__pumpAudio) window.__pumpAudio(d.latestSequence); }catch(x){} };
    es1.onerror=function(){ es1.close(); };
    var es2=new EventSource(api('/location/stream'));
    es2.onmessage=function(e){ try{ var d=JSON.parse(e.data); if(d.location){ lastLoc=d.location; lastTrail=d.trail||lastTrail; applyLocation(d.location,lastTrail); } }catch(x){} };
    es2.onerror=function(){ es2.close(); };
  }catch(x){}

  // ---- coordinator secures (Brief 12 P2): a single, deliberate confirm step.
  // No pin entry — the coordinator never types the user's code; they review the
  // PIN sat/unsat status and confirm. This is also the only "responding" claim:
  // coordination was already claimed by the deliberate Take-coordination POST,
  // so there is no second "I am responding" affordance here. ----
  var secureAlert=el('secureAlert');
  if(secureAlert){ secureAlert.onclick=function(){
    if(!window.confirm('Are you sure this person is safe? This ends the alert and stops recording.')){ return; }
    secureAlert.disabled=true; secureAlert.textContent='SECURING…';
    fetch(api('/secure'),{method:'POST'}).then(function(r){ return r.json(); }).then(function(d){
      if(d&&d.secured){ secureAlert.textContent='SECURED ✓'; }
      else { secureAlert.disabled=false; secureAlert.textContent='SECURE — END ALERT'; alert('Could not secure. Try again.'); }
    }).catch(function(){ secureAlert.disabled=false; secureAlert.textContent='SECURE — END ALERT'; });
  };}
  // ---- share with authorities: mint a dispatch link + QR (Fix Brief 4 G1) ----
  var sa=el('shareAuth');
  if(sa){ sa.onclick=function(){
    sa.disabled=true; sa.textContent='MINTING…';
    fetch(api('/dispatch-link')).then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); }).then(function(res){
      sa.disabled=false; sa.textContent='SHARE WITH AUTHORITIES';
      if(res.ok && res.d && res.d.url){
        var qb=el('dispatchQr'); if(qb){ qb.innerHTML=res.d.qr||''; }
        var u=el('dispatchUrl'); if(u){ u.value=res.d.url; }
        el('dispatchModal').classList.add('open');
      } else {
        alert('Only the responding coordinator can share with authorities.');
      }
    }).catch(function(){ sa.disabled=false; sa.textContent='SHARE WITH AUTHORITIES'; alert('Could not create the link. Try again.'); });
  };}
  (function(){
    var close=el('dispatchClose'); if(close){ close.onclick=function(){ el('dispatchModal').classList.remove('open'); }; }
    var copy=el('dispatchCopy'); if(copy){ copy.onclick=function(){
      var u=el('dispatchUrl'); if(!u) return;
      u.select();
      if(navigator.clipboard){ navigator.clipboard.writeText(u.value).then(function(){ copy.textContent='Copied ✓'; setTimeout(function(){ copy.textContent='Copy link'; },1800); }).catch(function(){}); }
    };}
  })();

  // ---- export = custody transfer + sealed vault (downloads the signed manifest) ----
  var exp=el('exportPkg');
  if(exp){ exp.onclick=function(){
    exp.disabled=true; exp.textContent='SEALING…';
    fetch(api('/export')).then(function(r){ return r.json(); }).then(function(d){
      if(d&&d.manifest){
        var blob=new Blob([JSON.stringify(d.manifest,null,2)],{type:'application/json'});
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a'); a.href=url; a.download='blackbox-'+CFG.eventId+'-manifest.json'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        exp.textContent='SEALED '+(d.packageHash?d.packageHash.slice(0,8):'')+' ✓';
        if(d.custodyId){ fetch(api('/custody/'+d.custodyId+'/ack'),{method:'POST'}).catch(function(){}); }
      } else { exp.disabled=false; exp.textContent='EXPORT EVIDENCE PACKAGE'; }
    }).catch(function(){ exp.disabled=false; exp.textContent='EXPORT EVIDENCE PACKAGE'; });
  };}
})();
`;
