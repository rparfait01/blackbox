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

import { CATEGORY_LABEL, categoryLabel, formatDtg, formatLocalClock } from '@blackbox/shared';
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
    // Brief 50 §C — an empty panel must never read as "nothing was said".
    //
    // Zero fragments is ambiguous between silence, not-transcribing, and not-yet. "Listening…"
    // asserts the first, which is the one thing we cannot know, and it was shown throughout a
    // capture that was never transcribed at all. The device reports which it is; absent that
    // report we say we do not know, rather than guessing in the reassuring direction.
    const t = state.transcription;
    // Brief 55 §A2 — "Audio is still recording" used to be appended here unconditionally, and on
    // the covert event that produced this brief it was false: the denial that took transcription
    // had taken the recorder too. The audio clause is now OBSERVED from the chunk count, so the
    // two states this panel can be in — transcription failed but capture is fine, versus both
    // failed — are finally distinguishable to the person reading it.
    const audioClause = audioReceived(state)
      ? ' Audio IS recording.'
      : ' <b class="cap-none">AND NO AUDIO HAS REACHED US EITHER</b> — this device is sending no recording at all.';
    if (t.state === 'unavailable') {
      return `<div class="muted stream-warn">NOT TRANSCRIBED — this device could not transcribe speech.${audioClause}${
        t.detail ? ` (${escapeHtml(t.detail)})` : ''
      }</div>`;
    }
    if (t.state === 'degraded') {
      return `<div class="muted stream-warn">TRANSCRIPTION DEGRADED — words may be missing.${audioClause}${
        t.detail ? ` (${escapeHtml(t.detail)})` : ''
      }</div>`;
    }
    if (t.state === 'active') {
      return '<div class="muted">Transcribing — nothing heard yet.</div>';
    }
    return '<div class="muted">Waiting for the device to report whether it is transcribing.</div>';
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

// Brief 55 §D — the label map is imported, not declared. It used to be declared HERE and again
// at the bottom of this same file as `SIT_LBL`, a string inside the client script: two copies of
// one vocabulary that had to agree and that nothing forced to. The client copy is now generated
// from this import (see the `SIT_LBL` assignment below), so there is one definition.
const catLabel = categoryLabel;

/**
 * Brief 55 §A2 — HAS ANY CHUNK ACTUALLY ARRIVED?
 *
 * The single question every capture claim on this page must be gated on, and the one nothing
 * asked. `latestSequence` is null until a chunk is stored, so this is an OBSERVATION — it cannot
 * be asserted by a client that is not recording, and it costs nothing to read because the state
 * builder already computes it.
 */
function audioReceived(state: ContactState): boolean {
  return state.audio.latestSequence != null;
}

/**
 * Brief 55 §A2 — the honest statement about capture, for a page that used to print
 * "Audio + location active" over an event that had never received a single byte.
 *
 * A live device test triggered a covert event that ran 74 seconds, uploaded 8 location fixes, and
 * stored ZERO chunks: the OS had refused the page a microphone. Every capture line on this
 * dashboard still read as normal, because all of them were reached from `situation.hasSignal` —
 * derived from CLASSIFICATION rows — and none of them read the chunk count sitting in the same
 * state object. The server held the disproof and rendered the claim anyway.
 */
const CAPTURE_COPY = {
  received: 'Audio + location active.',
  activeNone:
    '<b class="cap-none">NO AUDIO RECEIVED.</b> Location is arriving; no recording has reached us. Treat this as an alert with no capture — do not read silence as calm.',
  closedNone: '<b class="cap-none">NO AUDIO RECEIVED.</b> This event closed without any recording reaching us.',
};

function captureLine(state: ContactState): string {
  if (audioReceived(state)) {
    return CAPTURE_COPY.received;
  }
  return state.active ? CAPTURE_COPY.activeNone : CAPTURE_COPY.closedNone;
}
/**
 * How each threat level is BADGED — colour class and reader-facing word, in one table.
 *
 * Brief 55 §D — this was two implementations, and they disagreed. The server applied Brief 52
 * §D correctly (UNCLASSIFIED and UNKNOWN never wear the low-threat colour, and they get words
 * rather than a shouted level). The client poll renderer at the bottom of this file had its own
 * inline ternary that knew only high/medium/low — so every poll after the first REPAINTED a
 * correct grey "NOT CLASSIFIED" badge as a green "UNCLASSIFIED" one. A green badge on speech
 * nobody could read says "we listened and it is fine" when the truth is "we could not read this
 * at all", and the fix for that shipped in Brief 52 was being undone three seconds later.
 *
 * The table is now emitted into the client script verbatim, so there is nothing left to diverge.
 */
const THREAT_BADGE: Record<string, { cls: string; label: string }> = {
  critical: { cls: 'th-high', label: 'CRITICAL' },
  high: { cls: 'th-high', label: 'HIGH' },
  medium: { cls: 'th-med', label: 'MEDIUM' },
  low: { cls: 'th-low', label: 'LOW' },
  unclassified: { cls: 'th-unclassified', label: 'NOT CLASSIFIED' },
  unknown: { cls: 'th-unclassified', label: 'NO AUDIO YET' },
};
function threatBadge(level: string): { cls: string; label: string } {
  return THREAT_BADGE[level] ?? { cls: 'th-low', label: level.toUpperCase() };
}
function threatClass(level: string): string {
  return threatBadge(level).cls;
}

/** The reader-facing word. `unclassified` says what happened; it does not imply a severity. */
function threatLabel(level: string): string {
  return threatBadge(level).label;
}
const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Manual activation',
  deadman: 'Deadman (released)',
  tamper: 'Tamper',
};

/**
 * Brief 56 §A2 — WHO ELSE ALREADY KNOWS.
 *
 * The cascade halts the moment a coordinator claims, and it always has. What no surface said is
 * where in the chain the halt landed. A live device test made the cost obvious: claim latency
 * from the first notification is 6.6–13.9s and the second contact is dispatched at T+10s, so
 * whether one contact or two had been reached was decided by a coin flip that nobody could see
 * afterwards. Both the coordinator and the survivor have a direct interest in the answer.
 *
 * Reads `cascadeStepAtClaim`, captured in the same atomic UPDATE as the claim itself.
 */
function cascadeReachHtml(state: ContactState): string {
  const { dispatched, total, notifiedBeforeClaim } = state.cascade;
  if (total === 0) {
    return '';
  }
  if (notifiedBeforeClaim == null) {
    return `<div class="muted">${dispatched} of ${total} contacts notified. No one has taken coordination yet — the cascade is still running.</div>`;
  }
  const extra = dispatched > notifiedBeforeClaim ? ` (${dispatched} in total; the rest could not be halted — see the operator log.)` : '';
  return `<div class="muted"><b>${notifiedBeforeClaim} of ${total}</b> contacts were notified before you took coordination. The remaining ${Math.max(
    0,
    total - notifiedBeforeClaim,
  )} were not contacted.${extra}</div>`;
}

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
function situationHtml(state: ContactState): string {
  const s = state.situation;
  // Brief 55 §A2 — the capture claim is OBSERVED, not assumed. "No indicators detected yet"
  // over an event that is receiving nothing is not a quiet room; it is a blind alert, and the
  // two demand opposite responses from whoever is reading this.
  if (!s.hasSignal) {
    const cls = audioReceived(state) ? 'muted' : 'muted cap-warn';
    return `<div class="${cls}">No specific indicators detected yet. ${captureLine(state)}</div>`;
  }
  const parts: string[] = [];
  parts.push(
    `<div class="th-row"><span class="kv-k">Threat (rule-derived)</span><span class="th-badge ${threatClass(
      s.threatLevel,
    )}">${escapeHtml(threatLabel(s.threatLevel))}</span></div>`,
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
  // §A2 — signals and capture are INDEPENDENT. Classification rows come from the transcript, and
  // a transcript can exist with no recording behind it. Detected facts must never be allowed to
  // imply that the recording they describe is being retained.
  if (!audioReceived(state)) {
    parts.push(`<div class="muted cap-warn">${captureLine(state)}</div>`);
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

  ${role === 'coordinator' ? '<div class="lockout-warn" id="lockoutWarn" style="display:none">⚠ Repeated failed closure attempts on the device — this may not be the user. Do not assume safe.</div>' : ''}
  ${role === 'coordinator' ? '<div class="closure-window" id="closureWindow" style="display:none"></div>' : ''}

  <div class="bar">
    <div class="rec" id="rec">${recording}</div>
    <div class="elapsed" id="elapsed">${clock(state.durationMs)}</div>
  </div>

  <!-- Fix Brief 8: the live map leads the coordinator view. Then
       ORIGIN → SITUATION → CAMERA → TRANSCRIPT(secondary) → audio/devices. -->
  <section class="sec">
    <div class="label"><span class="stream-state" id="locationState">—</span> Location · Live</div>
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
    <div id="situation">${situationHtml(state)}</div>
  </section>

  <section class="sec">
    <div class="label">Who else was notified</div>
    <div id="cascadeReach">${cascadeReachHtml(state)}</div>
  </section>

  <section class="sec sec-camera">
    <div class="label">Live camera <span class="stream-state" id="camState">—</span></div>
    ${
      state.hasVideo
        ? '<video id="cam" class="camera" controls playsinline muted></video><div class="muted" id="camNote"></div>'
        : `<div class="map-empty stream-warn">No camera feed. Video was requested and the device could not provide it — ${
            // §A2 — the old copy ended "audio and location are recording", asserted unconditionally.
            // On the covert event that produced this brief it was FALSE: the same denial that took
            // the camera had taken the microphone, and this line reassured the coordinator about a
            // recording that did not exist.
            audioReceived(state) ? 'audio and location are recording.' : 'and NO AUDIO HAS REACHED US EITHER. Location only.'
          }</div>`
    }
  </section>

  <section class="sec sec-transcript">
    <div class="label">Live transcript · secondary (evidence/replay) <span class="stream-state" id="transcriptState">—</span></div>
    <div class="transcript transcript-secondary" id="transcript">${transcriptHtml(state)}</div>
  </section>

  <section class="sec">
    <div class="label">Audio <span class="stream-state" id="audioState">—</span></div>
    <audio id="audio" class="audio" preload="auto"></audio>
    <button id="audioStart" class="audio-start" hidden>Tap to start audio</button>
    <div class="muted" id="audioNote"></div>
  </section>

  <section class="sec">
    <div class="label">Capture source</div>
    <div class="muted sec-source">${
      // §A2 — this named the hardware we ASKED for, not the hardware that produced anything.
      // "Phone microphone" beside a zero-chunk event is a claim about a capture that never was.
      audioReceived(state)
        ? `${state.hasVideo ? 'Phone microphone &amp; camera' : 'Phone microphone'} · no external hardware paired`
        : 'No capture has reached us from this device · nothing received to attribute to a source'
    }</div>
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
        ? '<button id="secureAlert" class="btn btn-secure" title="Request or confirm closure — both you and the user must assent">REQUEST CLOSURE</button>'
        : ''
    }
  </div>

  <div class="ended-banner" id="endedBanner" ${state.active ? 'hidden' : ''}>
    Session ended — recording has stopped.
  </div>

  <!-- Brief 49 §C — shown only after the socket has given up entirely. The 3s poll is the
       correctness guarantee, so losing the socket costs latency and not correctness; the
       notice exists because a silently degraded page is how a coordinator stops trusting
       what they are looking at. -->
  <div class="ended-banner" id="wsNotice" hidden></div>

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
    <!-- Brief 49 §D — shown when the poll stops because the event closed, so the last
         coordinates on screen are never mistaken for current ones. -->
    <div class="muted" id="notifiedEnded" style="margin-top:8px;font-size:13px" hidden></div>
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

// Location-only poll for the notified view (Brief 49 §D). Deliberately fetches NOTHING but
// /state.location (no audio).
//
// This carried the same defect as the coordinator view in a quieter form: setInterval at 5s,
// never cleared, no visibility check, no stop on closure — 17,280 requests a day per tab, for
// a view that shows one pair of coordinates. It is treated identically here rather than being
// judged less important, because "less important" is how the second copy of a bug survives the
// fix to the first.
const NOTIFIED_JS = `
(function(){
  var CFG=window.__CFG;
  var POLL_LIVE_MS=5000, POLL_HIDDEN_MS=30000;
  var timer=null, stopped=false;
  function intervalMs(){ return document.hidden ? POLL_HIDDEN_MS : POLL_LIVE_MS; }
  function schedule(){
    if(stopped) return;
    if(timer!==null){ clearTimeout(timer); }
    timer=setTimeout(function(){ poll(); }, intervalMs());
  }
  function stop(st){
    if(stopped) return;
    stopped=true;
    if(timer!==null){ clearTimeout(timer); timer=null; }
    var n=document.getElementById('notifiedEnded');
    if(n){
      var dtg=(st&&st.closedDtg)?st.closedDtg:null;
      n.textContent=(dtg?('This event closed at '+dtg+'. '):'This event has closed. ')
                    +'This view is no longer live. Reload for current state.';
      n.hidden=false;
    }
  }
  // Brief 33 Fix C — the SAME defect as the coordinator view, at 5s instead of 3s: 17,280
  // requests a day per tab, for a view that shows one pair of coordinates. Treated identically
  // here rather than judged less important, because "less important" is how the second copy of
  // a bug survives the fix to the first. It survived once already.
  var TERMINAL_STATUS={401:1,403:1,404:1,410:1};
  var fails=0, MAX_FAILS=8, BACKOFF=[5000,10000,20000,40000,60000];
  function failed(){
    fails++;
    if(fails>=MAX_FAILS){ expire(); return; }
    if(timer!==null){ clearTimeout(timer); }
    var d=BACKOFF[Math.min(fails, BACKOFF.length-1)];
    timer=setTimeout(function(){ poll(); }, Math.round(d*(0.75+Math.random()*0.5)));
  }
  function expire(){
    if(stopped) return;
    stopped=true;
    if(timer!==null){ clearTimeout(timer); timer=null; }
    var n=document.getElementById('notifiedEnded');
    if(n){ n.textContent='This session has expired. Reload to reconnect.'; n.hidden=false; }
  }
  function poll(){
    if(stopped) return;
    fetch(CFG.base+'/v1/c/'+CFG.eventId+'/state'+location.search).then(function(r){
      if(TERMINAL_STATUS[r.status]){ expire(); return null; }
      if(!r.ok){ failed(); return null; }
      return r.json().catch(function(){ failed(); return null; });
    }).then(function(st){
      if(!st){ return; }
      fails=0;
      if(st.location){ var c=document.getElementById('coords'); if(c){ c.textContent=st.location.lat.toFixed(4)+'°, '+st.location.lon.toFixed(4)+'°'; } }
      if(st.terminal===true||st.active===false){ stop(st); return; }
      schedule();
    }).catch(function(){ failed(); });
  }
  poll();
  document.addEventListener('visibilitychange', function(){
    if(stopped) return;
    if(!document.hidden){ poll(); } else { schedule(); }
  });
  // Take coordination: deliberate claim, then reload into the full coordinator view.
  var tc=document.getElementById('takeCoord');
  if(tc){ tc.onclick=function(){
    tc.disabled=true; tc.textContent='CLAIMING…';
    // credentials:'include' so the bbview session goes with it. location.search is empty on the
    // redeemed bare URL and carries the token only on the cookie-blocked fallback — both work,
    // because the route now resolves through the one shared helper.
    fetch(CFG.base+'/v1/c/'+CFG.eventId+'/claim-coordinator'+location.search,{method:'POST',credentials:'include'})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){ return {status:r.status,ok:r.ok,d:d}; }); })
      .then(function(res){
        if(res.ok && res.d && res.d.claimed){ window.location.reload(); return; }
        tc.disabled=false; tc.textContent='TAKE COORDINATION';
        // SAY WHAT HAPPENED, NOT WHAT WE GUESS HAPPENED.
        //
        // This reported EVERY failure as "Another responder has already taken coordination." A
        // responder told someone else is handling it stands down: they do not retry, they do not
        // escalate, they wait. That string turned a 401 into a stand-down instruction while no
        // coordinator existed and nobody could become one.
        var msg;
        if(res.status===409){ msg='Another responder has already taken coordination.'; }
        else if(res.status===401){ msg='This link is not authorised to take coordination. Open the most recent alert message and use the link there.'; }
        else { msg='Could not take coordination (error '+res.status+'). The alert is still active — try again.'; }
        alert(msg);
      }).catch(function(){
        tc.disabled=false; tc.textContent='TAKE COORDINATION';
        alert('Could not reach the server. The alert is still active — try again.');
      });
  };}
})();
`;

/**
 * §B — the self-service path off a spent link. A button and a status line, no support request.
 *
 * The request is a POST from a click, which is also the shape a link scanner cannot produce — the
 * same reasoning that governs redemption. It asks the server to re-send through the SAME cascade
 * channel the alert used; the fresh link is never rendered into this page, because a page reached
 * by an unauthenticated request must not become a way to mint credentials.
 */
const SPENT_SELF_SERVICE = `<p><button class="fresh" id="fresh">Send me a fresh link</button></p>
<p id="fl" class="muted"></p>
<script>
document.getElementById('fresh').addEventListener('click', function () {
  // No regex: this whole script lives inside a TS template literal, where a backslash is an
  // escape the compiler eats before the browser ever sees it. The path here is always /c/<id>,
  // so prefixing is exact and needs no escaping at all.
  var api = '/v1' + location.pathname + '/fresh-link';
  var out = document.getElementById('fl');
  out.textContent = 'Sending…';
  fetch(api, { method: 'POST', credentials: 'include' }).then(function (r) {
    out.textContent = r.ok
      ? 'Sent. It will arrive the same way the alert did.'
      : 'Could not send. Open the most recent alert message and use the link there.';
  }).catch(function () {
    out.textContent = 'Could not send. Open the most recent alert message and use the link there.';
  });
});
</script>`;

/**
 * Brief 33 Fix B §B — 'spent' is a THIRD outcome, and it must never be a dead end.
 *
 * A spent link means a human already opened this alert in another browser. The person reading
 * this page is not an attacker in the expected case — they are the same coordinator on a second
 * device, or a second contact the cascade also notified. Telling them "invalid" would be both
 * wrong and useless at 3am.
 *
 * So it says what happened in plain words and gives a SELF-SERVICE path: request a fresh link
 * through the same channel the alert arrived on. No support request, no dead end.
 */
export function renderTokenPage(kind: 'expired' | 'invalid' | 'spent'): string {
  const heading =
    kind === 'expired'
      ? 'This live link has expired'
      : kind === 'spent'
        ? 'This link is already open somewhere else'
        : 'This link is not valid';
  const body =
    kind === 'expired'
      ? 'Live links are active for one hour. Check LINE for the most recent alert message and open the dashboard link there.'
      : kind === 'spent'
        ? 'Someone has already opened this alert from another device or browser — that may well have been you. ' +
          'To open it here, request a fresh link and it will arrive the same way the alert did.'
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
  ${kind === 'spent' ? SPENT_SELF_SERVICE : ''}
</main>
</body>
</html>`;
}

const CSS = `
/* Brief 50 §E — every stream declares its own state, and the colours are not decoration.
   A coordinator glancing at this page must be able to tell "nothing is happening" from
   "you stopped receiving ten minutes ago" without reading a word. */
.stream-state{font-size:10px;letter-spacing:.08em;font-weight:700;padding:2px 6px;border-radius:4px;vertical-align:middle;margin-left:6px}
.ss-live{background:#0a3d20;color:#5ee08a}
.ss-degraded{background:#4a3200;color:#ffc14d}
.ss-stopped{background:#4a0d0d;color:#ff8080}
.stream-warn{color:#ffc14d}
/* Brief 55 §A2 — a capture claim that failed its observation check. Read at a glance, because
   an alert with no evidence behind it is the condition that must never look ordinary. */
.cap-warn{color:#ffc14d}
.cap-none{color:#ff6b6b;letter-spacing:.04em}
/* Brief 52 §D — unclassified is amber-on-dark: visible, unmistakably NOT the low-threat green. */
.th-unclassified{background:#4a3200;color:#ffc14d}

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
.lockout-warn{border:2px solid #ff3b30;background:#2a0d0d;color:#ff8f88;border-radius:10px;padding:12px;margin:8px 0;font-size:13px;font-weight:600;line-height:1.4}
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
  // Brief 33 Fix B - NO TOKEN ON THE WIRE.
  //
  // Every one of these URLs used to carry the token as a query parameter, so the coordinator's
  // credential sat in every request line, every proxy log, and the WebSocket handshake for the
  // whole of a live alert. Auth is now the HttpOnly bbview cookie, which none of those can see.
  //
  // The query fallback survives only when the page was served with a token still in hand: the
  // cookie may be blocked or cleared, and a coordinator wrongly refused is worse than a token
  // wrongly honoured. When the exchange worked, CFG.token is empty and this is ''.
  //
  // (No backticks in this comment on purpose - the whole script is inside a TS template literal,
  // and one backtick here terminates it. That is exactly how this block broke once already.)
  var base=CFG.base, q=CFG.token?('?t='+encodeURIComponent(CFG.token)):'';
  function api(path){return base+'/v1/c/'+CFG.eventId+path+q;}

  // The human signal that binds this link to this browser. A link scanner issues GETs and runs
  // no page script, so it never reaches this line and never spends a coordinator's link.
  try{ fetch(api('/redeem'),{method:'POST',credentials:'include'}); }catch(e){}
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
  // Brief 55 §D — EMITTED from the server's own tables, never retyped. Two hand-kept copies of a
  // vocabulary are two chances to disagree, and they did.
  var SIT_LBL=${JSON.stringify(CATEGORY_LABEL)};
  var TH_BADGE=${JSON.stringify(THREAT_BADGE)};
  function sitEsc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function thBadge(l){ return TH_BADGE[l]||{cls:'th-low',label:String(l).toUpperCase()}; }
  // §A2 — the client asks the same question the server does: has a chunk actually arrived?
  function capReceived(){ return S.audio && S.audio.latestSequence!=null; }
  var CAP_COPY=${JSON.stringify(CAPTURE_COPY)};
  /** The capture-source line is a claim about hardware that produced something. Re-rendered
   *  with everything else, because "Phone microphone" beside a zero-chunk event is the same
   *  false claim in a quieter place. */
  function applyCaptureSource(){
    var n=document.querySelector('.sec-source');
    if(!n) return;
    n.innerHTML = capReceived()
      ? ((S.hasVideo?'Phone microphone &amp; camera':'Phone microphone')+' · no external hardware paired')
      : 'No capture has reached us from this device · nothing received to attribute to a source';
  }

  function capLine(){
    if(capReceived()) return CAP_COPY.received;
    return active ? CAP_COPY.activeNone : CAP_COPY.closedNone;
  }
  function applySituation(s){
    var node=el('situation'); if(!node||!s) return;
    if(!s.hasSignal){ node.innerHTML='<div class="'+(capReceived()?'muted':'muted cap-warn')+'">No specific indicators detected yet. '+capLine()+'</div>'; return; }
    var b=thBadge(s.threatLevel||'unknown');
    var html='<div class="th-row"><span class="kv-k">Threat (rule-derived)</span><span class="th-badge '+b.cls+'">'+sitEsc(b.label)+'</span></div>';
    if(s.categories&&s.categories.length){ html+='<div class="facts">'; for(var i=0;i<s.categories.length;i++){ var c=s.categories[i].category; html+='<span class="fact">'+sitEsc(SIT_LBL[c]||c)+'</span>'; } html+='</div>'; }
    if(s.toneIndicators&&s.toneIndicators.length){ html+='<div class="facts">'; for(var j=0;j<s.toneIndicators.length;j++){ html+='<span class="fact fact-tone">'+sitEsc(String(s.toneIndicators[j]).replace(/-/g,' '))+'</span>'; } html+='</div>'; }
    if(s.multipleVoicesInferred){ html+='<div class="inferred">Multiple voices detected — inferred, low confidence</div>'; }
    if(!capReceived()){ html+='<div class="muted cap-warn">'+capLine()+'</div>'; }
    node.innerHTML=html;
  }
  applyTranscript(S.latestTranscriptFragments);
  applySituation(S.situation);

  // Coordinator closure window (Brief 9 Phase D): shows the user's closure
  // request — PIN sat/unsat (duress unmistakable), reason — and the SECURE
  // action with an explicit "are you sure" confirmation.
  function applyClosure(cl){
    var w=el('closureWindow'); if(!w) return;
    // Repeated wrong closure-pin attempts (Brief 19 §6): surface to the coordinator
    // even with no closure request — it can mean someone other than the user is
    // trying to close. Shown as a standalone warning above the closure window.
    var lw=el('lockoutWarn');
    if(lw){
      // §3: when the coordinator path has failed, the guardian is the qualified
      // confirmer — surface it prominently (re-uses the warning banner slot).
      if(cl && cl.coordinatorFailed){
        lw.style.display='block';
        lw.textContent='⚠ Coordinator did not confirm in time — the GUARDIAN is now the qualified confirmer. Guardian: reload this page to take coordination, then confirm the user\\'s next request.';
      } else {
        lw.textContent='⚠ Repeated failed closure attempts on the device — this may not be the user. Do not assume safe.';
        lw.style.display = (cl && cl.lockout) ? 'block' : 'none';
      }
    }
    // The SECURE control is INERT until the user requests closure (canonical rule):
    // no pending request = nothing to approve. The server enforces this too; this
    // keeps the UI honest so a coordinator is never offered a live END with no
    // request behind it. A closed event leaves the (now hidden) button alone.
    var sec=el('secureAlert');
    var pending = !!(cl && cl.requested);
    // §2 symmetric consent: the coordinator may REQUEST closure (first assent,
    // queued) or CONFIRM the user's request (second assent → closes). The control
    // is always live; it never closes unilaterally (the server enforces both).
    if(sec && sec.textContent!=='SECURED ✓' && sec.textContent!=='SECURING…' && sec.textContent!=='CLOSURE REQUESTED — AWAITING USER'){
      sec.disabled = false;
      sec.textContent = pending ? 'CONFIRM CLOSURE — END ALERT' : 'REQUEST CLOSURE';
    }
    if(!cl || !cl.requested){ w.style.display='none'; w.innerHTML=''; return; }
    var duress = cl.pin==='unsat';
    w.style.display='block';
    w.className = duress ? 'closure-window duress' : 'closure-window';
    var html='<div class="cw-title">Closure requested by the user</div>';
    var disp = cl.tampering ? 'TAMPERING' : (duress?'UNSAT · DURESS':'SAT');
    html+='<div class="cw-row"><span>STATUS</span><span class="'+((duress||cl.tampering)?'cw-bad':'cw-ok')+'">'+disp+'</span></div>';
    if(cl.tampering){ html+='<div class="cw-warn">⚠ TAMPERING — repeated duress signals in a short window. Responders stay engaged. Securing requires an explicit override with a logged reason; do NOT assume safe.</div>'; }
    else if(duress){ html+='<div class="cw-warn">THREAT ONGOING — do not assume safe. Validate that the user is genuinely safe before securing.</div>'; }
    if(cl.reasonSecured){ html+='<div class="cw-reason">Reason for securing: '+sitEsc(cl.reasonSecured)+'</div>'; }
    // Status only — the coordinator secures via the single SECURE control below
    // (the confirm step), seeing PIN sat/unsat. They never enter the pin.
    html+='<div class="cw-reason">Review, then use <b>SECURE — END ALERT</b> below to confirm. You never enter a pin.</div>';
    w.innerHTML=html;
  }
  applyClosure(S.closure);

  // ---- stream state badges: every stream says live / degraded / stopped ----
  //
  // Brief 33 Fix A's rule applied to the DATA rather than the view. A stream that silently stops
  // is worse than one that reports stopped: a coordinator watching a still frame cannot tell
  // "nothing is happening" from "you stopped receiving ten minutes ago", and those demand
  // opposite responses.
  function setState(id, kind, text){
    var n=el(id); if(!n) return;
    n.textContent=text; n.className='stream-state ss-'+kind;
  }

  // ---- media: ONE MSE path, driven by what was ACTUALLY stored ----
  //
  // ═══ THIS BLOCK USED TO RUN EXACTLY ONCE, AT PAGE LOAD, AND NEVER AGAIN. ═══════════════════
  //
  // That single fact produced three separate device-test findings:
  //
  //   * "NO AUDIO RECEIVED" beside a LIVE TRANSCRIPT of real speech. The transcript is
  //     re-rendered every poll; the audio claim was computed once from the load-time snapshot
  //     and never recomputed. Both were on screen together, and only one of them was current.
  //   * The camera panel appearing in one mode and not the other. It never branched on mode at
  //     all — it branched on WHEN the coordinator opened the page. Opened at T+0, before the
  //     first chunk landed, hasVideo was false and stayed false forever. Opened a minute later,
  //     it was true. Same capture, opposite panels.
  //   * A large empty black area: a <video controls> element rendered with NO src, because the
  //     media pipeline had decided at load time that there was nothing to play and had no way
  //     to change its mind.
  //
  // The capture itself was fine in all three. Every one of them was this page believing a
  // snapshot. So the media state is now READ FROM THE POLL like everything else, and the
  // pipeline initialises on the first chunk that actually arrives rather than on what happened
  // to exist when the page was opened.
  var audio=el('audio'), note=el('audioNote'), startBtn=el('audioStart'), cam=el('cam');
  var knownLatest=S.audio.latestSequence, mime=S.audio.mimeType;
  var mediaReady=false;

  /**
   * Put the <video> element in the camera panel when the server first reports video.
   *
   * The panel is server-rendered from hasVideo at load. When that was false and a video chunk
   * later arrives, the element the pipeline needs does not exist, so it is created here rather
   * than leaving a permanent "No camera feed" over a camera that is plainly working.
   */
  function ensureCameraEl(){
    var sec=document.querySelector('.sec-camera'); if(!sec) return;
    if(!el('cam')){
      var lbl=sec.querySelector('.label');
      sec.innerHTML='';
      if(lbl) sec.appendChild(lbl);
      var v=document.createElement('video');
      v.id='cam'; v.className='camera'; v.setAttribute('playsinline',''); v.muted=true; v.controls=true;
      sec.appendChild(v);
      var n=document.createElement('div'); n.className='muted'; n.id='camNote'; sec.appendChild(n);
    }
    cam=el('cam');
  }

  /** The camera panel when the server says there is no video. Re-rendered, not frozen. */
  function cameraAbsent(){
    var sec=document.querySelector('.sec-camera'); if(!sec) return;
    if(el('cam')) return; // video already mounted — never tear a live element down
    var body=sec.querySelector('.map-empty');
    if(body){ body.innerHTML='No camera feed. Video was requested and the device could not provide it — '+(capReceived()?'audio and location are recording.':'and <b class="cap-none">NO AUDIO HAS REACHED US EITHER</b> — location only.'); }
  }

  function initMedia(){

  // THE CODEC IS DERIVED, NEVER GUESSED.
  //
  // This function used to map every video/webm to codecs="vp8,opus". The recorder produces VP9
  // (vp09.00.10.08). MediaSource.isTypeSupported says yes to the VP8 string, so MSE engaged, a
  // SourceBuffer was created declaring VP8, VP9 bytes were appended to it, and nothing decoded.
  // No picture AND no voice — the audio is muxed inside that same stream — which is exactly the
  // Visible-mode failure this brief was written about.
  //
  // A codec mismatch MSE accepts and cannot decode is silent failure. The stored mimeType already
  // carries its own codecs parameter, recorded from the actual MediaRecorder, so the honest
  // answer is to use it verbatim. Synthesis happens ONLY when the stored type carries no codecs
  // at all, and even then it is a last resort rather than an override.
  function normMime(m){
    if(!m) return '';
    if(m.indexOf('codecs')!==-1) return m;           // recorded reality — never second-guess it
    if(m.indexOf('audio/mp4')===0) return 'audio/mp4; codecs="mp4a.40.2"';
    if(m.indexOf('audio/webm')===0) return 'audio/webm; codecs="opus"';
    return m;                                        // unknown: let the browser decide, do not invent
  }
  var isVideo = (mime||'').indexOf('video/')===0;
  // Video plays in the <video> element. Feeding a video stream to <audio> renders no picture no
  // matter how correct the codec is, which is the second half of why nothing was visible.
  var media = (isVideo && cam) ? cam : audio;
  var mediaStateId = (media===cam) ? 'camState' : 'audioState';
  function tryAutoplay(){ var p=media.play(); if(p&&p.catch){ p.catch(function(){ startBtn.hidden=false; startBtn.onclick=function(){ media.play(); startBtn.hidden=true; }; }); } }
  var useMse=false, nm=normMime(mime);
  if(knownLatest!=null && window.MediaSource && nm && window.MediaSource.isTypeSupported(nm)){
    useMse=true;
    var ms=new MediaSource(); media.src=URL.createObjectURL(ms);
    var sb=null, nextSeq=0, queue=[], fetching=false;
    ms.addEventListener('sourceopen',function(){ sb=ms.addSourceBuffer(nm); sb.addEventListener('updateend',pump); pumpFetch(); });
    // A decode failure is DECLARED, not swallowed. appendBuffer throwing is exactly what the
    // VP8/VP9 mismatch produced, and the old empty catch is why it presented as silence.
    function pump(){
      if(sb && !sb.updating && queue.length){
        try{ sb.appendBuffer(queue.shift()); }
        catch(e){ setState(mediaStateId,'degraded','DEGRADED — cannot decode'); note.textContent='This stream could not be decoded by this browser.'; }
      }
      catchUp();
    }
    function catchUp(){ try{ if(media.buffered.length){ var end=media.buffered.end(media.buffered.length-1); if(end-media.currentTime>6){ media.currentTime=end-2; } } }catch(e){} }
    function pumpFetch(){
      if(fetching) return;
      if(knownLatest==null || nextSeq>knownLatest){ return; }
      fetching=true;
      fetch(api('/audio/'+nextSeq)).then(function(r){ return r.ok?r.arrayBuffer():null; }).then(function(buf){
        fetching=false;
        if(buf){ queue.push(new Uint8Array(buf)); nextSeq++; pump(); }
        pumpFetch();
      }).catch(function(){ fetching=false; setState(mediaStateId,'degraded','DEGRADED — fetch failed'); });
    }
    window.__pumpAudio=function(latest){ if(latest!=null){ knownLatest=latest; } pumpFetch(); };
    tryAutoplay();
    setState(mediaStateId,'live', isVideo ? 'LIVE' : 'LIVE');
    media.addEventListener('error',function(){ setState(mediaStateId,'degraded','DEGRADED — playback error'); });
    note.textContent = isVideo ? 'Live video + audio · streaming' : 'Live audio · streaming';
  } else if(knownLatest!=null){
    // No MSE (iOS Safari): /audio/full is a byte-concatenation of independent
    // recorder segments, so a native <audio controls> reads a bogus 00:00
    // duration and a maxed scrubber. Show an honest download-to-play button
    // with NO timeline instead of a false time readout. Each play re-fetches
    // /audio/full so it includes everything captured so far.
    //
    // BRIEF 55 §B — THIS BRANCH USED TO BE AUDIO-ONLY, AND VIDEO FELL THROUGH IT.
    //
    // On the device test the camera panel showed a <video controls> element with no source: a
    // player reading 00:00 with a dead scrubber, directly under the words "LIVE CAMERA". An empty
    // transport is not a neutral thing to render — it reads as "nothing happened", which is the
    // one meaning it must never carry on this page. The audio path had already learned this and
    // says so in words; video simply had no equivalent, so it said nothing and looked broken.
    //
    // Now both media kinds take the same fallback: no timeline, an honest sentence, and a working
    // play button over everything captured so far.
    media.controls=false;
    var isVid=(media===cam);
    var playLabel=isVid?'▶ Play recording so far (video)':'▶ Play recording so far';
    startBtn.hidden=false;
    startBtn.textContent=playLabel;
    startBtn.onclick=function(){
      if(media.paused){ media.src=api('/audio/full'); media.play(); startBtn.textContent='⏸ Pause'; }
      else { media.pause(); startBtn.textContent=playLabel; }
    };
    media.onended=function(){ startBtn.textContent=playLabel; };
    setState(mediaStateId,'degraded','NOT LIVE — playback only');
    // The sentence belongs next to the element it is about. A note under "Audio" explaining the
    // camera is how an empty video player stays unexplained.
    var noteText = isVid
      ? 'Recording · download-to-play. This browser cannot stream live video; press play to see and hear everything captured so far.'
      : 'Recording · download-to-play (this browser cannot stream live; press play to hear everything captured so far)';
    var camNote = el('camNote');
    if(isVid && camNote){ camNote.textContent=noteText; note.textContent='Audio is inside the camera recording above.'; }
    else { note.textContent=noteText; }
    window.__pumpAudio=function(latest){ if(latest!=null){ knownLatest=latest; } };
  } else {
    // §A2 — "not yet" and "never" are different claims and only one of them is reassuring.
    // Nothing has arrived; say that in the badge as well as the note, so a coordinator who
    // glances at the stream states sees it without reading.
    setState(mediaStateId,'degraded','NO AUDIO RECEIVED');
    note.textContent = active
      ? 'NO AUDIO RECEIVED. Nothing has reached us from this device — do not read this as a quiet room.'
      : 'NO AUDIO RECEIVED. This event closed without any recording reaching us.';
    window.__pumpAudio=function(latest){ if(latest!=null){ knownLatest=latest; } };
  }
  }

  /**
   * Bring the media pipeline up the moment the server reports a chunk — not before, and not
   * only at page load. Idempotent: it runs once, on the first poll that reports media.
   */
  function applyMedia(st){
    if(st && st.audio){ S.audio=st.audio; }
    if(st && typeof st.hasVideo==='boolean'){ S.hasVideo=st.hasVideo; }
    if(mediaReady){ if(window.__pumpAudio) window.__pumpAudio(S.audio?S.audio.latestSequence:null); return; }
    if(!S.audio || S.audio.latestSequence==null){ cameraAbsent(); return; }
    mediaReady=true;
    knownLatest=S.audio.latestSequence; mime=S.audio.mimeType;
    if(S.hasVideo){ ensureCameraEl(); }
    initMedia();
  }
  applyMedia(S);

  // ---- session-ended handling ----
  function applyStatus(st){
    if(st.active===false && active){
      active=false;
      el('rec').innerHTML='<span class="rec-text ended">Session ended</span>';
      el('endedBanner').hidden=false;
      var sa=el('secureAlert'); if(sa){ sa.style.display='none'; }
    }
  }

  // ---- /state polling backbone (Brief 49 §A/§B) ---------------------------------------
  //
  // WHAT THIS REPLACED, AND WHY IT MATTERED. This was 'setInterval(poll,3000)' with no
  // clearInterval anywhere, no visibility handling, and no stop on closure. A tab left open
  // on an event that closed days ago kept asking the Worker for its state every three
  // seconds — 28,800 requests a day, per tab, about nothing. That, plus the reconnect loop
  // below, is what exhausted the account's request budget; when the budget went, the alert
  // path went with it. A poll with no exit condition is a load generator, not a guarantee.
  //
  // The 3s cadence is still the correctness guarantee WHILE THE EVENT IS LIVE AND WATCHED
  // (SSE and the socket are latency enhancements on top). It is only the other three states
  // that were wrong: closed, hidden, and unreachable.
  var POLL_LIVE_MS=3000, POLL_HIDDEN_MS=30000;
  var pollTimer=null, pollStopped=false;

  function pollIntervalMs(){
    // Hidden tabs still poll — a coordinator with the tab in the background is still
    // coordinating — but at 30s rather than 3s. Browsers already throttle background
    // timers unevenly, so this makes the intent explicit rather than leaving the rate to
    // whatever the engine decides.
    return document.hidden ? POLL_HIDDEN_MS : POLL_LIVE_MS;
  }

  function schedulePoll(){
    if(pollStopped) return;
    if(pollTimer!==null){ clearTimeout(pollTimer); }
    // setTimeout, re-armed each tick, rather than setInterval: the cadence has to change
    // with visibility, and an interval cannot be re-rated without being torn down anyway.
    pollTimer=setTimeout(function(){ poll(); }, pollIntervalMs());
  }

  // §A — a closed event is terminal for this page. Stop asking, say so, and offer the one
  // action that gets current state: a reload. Silence would be worse than the old
  // behaviour; an unexplained frozen dashboard is how a coordinator misses something.
  function stopPolling(st){
    if(pollStopped) return;
    pollStopped=true;
    if(pollTimer!==null){ clearTimeout(pollTimer); pollTimer=null; }
    closeSocket();
    var b=el('endedBanner');
    if(b){
      var dtg=(st&&st.closedDtg)?st.closedDtg:null;
      b.textContent=(dtg?('This event closed at '+dtg+'. '):'This event has closed. ')
                    +'This view is no longer live. Reload for current state.';
      b.hidden=false;
    }
  }

  // ═══ BRIEF 33 FIX C — THE STOP CONDITION IS EVALUATED ON EVERY OUTCOME. ══════════════════
  //
  // This loop's stop was reachable ONLY on the success branch: r.ok ? r.json() : null, and a
  // null result rescheduled unconditionally. Any 401, 403, 404, 429 or 5xx therefore re-armed a 3
  // second timer forever, and nothing on screen changed — so a tab whose one-hour magic token
  // expired polled 28,800 times a day, invisibly, on a device nobody could reach.
  //
  // Terminal statuses stop for good. Transient ones back off, and then also stop. A poll that
  // cannot determine the event's state STOPS — it never assumes the event is still live,
  // because "I could not tell" and "it is still running" are different facts and only one of
  // them is safe to act on.
  var TERMINAL_STATUS={401:1,403:1,404:1,410:1};
  var pollFails=0;
  var POLL_MAX_FAILS=8;
  var POLL_BACKOFF_MS=[3000,6000,12000,24000,48000];
  var POLL_CAP_MS=60000;

  function pollFailureDelay(){
    var d=POLL_BACKOFF_MS[Math.min(pollFails, POLL_BACKOFF_MS.length-1)];
    if(d>POLL_CAP_MS) d=POLL_CAP_MS;
    return Math.round(d*(0.75+Math.random()*0.5));
  }

  /** A failure of any kind. Counts, backs off, and STOPS at the ceiling. */
  function pollFailed(){
    pollFails++;
    if(pollFails>=POLL_MAX_FAILS){ stopExpired(); return; }
    if(pollTimer!==null){ clearTimeout(pollTimer); }
    pollTimer=setTimeout(function(){ poll(); }, pollFailureDelay());
  }

  /** Terminal: stop permanently and say the one true thing we know. */
  function stopExpired(){
    if(pollStopped) return;
    pollStopped=true;
    if(pollTimer!==null){ clearTimeout(pollTimer); pollTimer=null; }
    closeSocket();
    var b=el('endedBanner');
    if(b){ b.textContent='This session has expired. Reload to reconnect.'; b.hidden=false; }
  }

  function poll(){
    if(pollStopped) return;
    fetch(api('/state')).then(function(r){
      if(TERMINAL_STATUS[r.status]){ stopExpired(); return null; }
      if(!r.ok){ pollFailed(); return null; }
      return r.json().catch(function(){ pollFailed(); return null; });
    }).then(function(st){
      if(!st){ return; }
      pollFails=0;
      S.closure=st.closure; S.active=st.active; // keep S fresh for the closure control
      durationMs=st.durationMs; baseNow=Date.now();
      if(st.location){ lastLoc=st.location; lastTrail=st.trail; applyLocation(st.location, st.trail); }
      applyTranscript(st.latestTranscriptFragments);
      applySituation(st.situation);
      applyClosure(st.closure);
      applyMedia(st);
      applyCaptureSource();
      applyStatus(st);
      // §E2 — the server can declare the view terminal explicitly, not only by active:false.
      // A client that understands this stops for any terminal reason the server names,
      // including one added later, without needing its own copy of the rules.
      if(st.terminal===true||st.active===false){ stopPolling(st); return; }
      schedulePoll();
    }).catch(function(){ pollFailed(); });
  }
  poll();

  // §B — react to visibility the instant it changes rather than waiting out the current
  // interval, so a coordinator who returns to the tab sees live state immediately instead
  // of up to 30 seconds stale.
  document.addEventListener('visibilitychange', function(){
    if(pollStopped) return;
    if(!document.hidden){ poll(); } else { schedulePoll(); }
  });

  // ---- §4 live server push, with a BOUNDED reconnect (Brief 49 §C) ---------------------
  //
  // THE P0. This was 'ws.onclose = setTimeout(connectWS,3000)' — a fixed 3s
  // retry with no backoff, no ceiling, and no closed-event check. When the Worker was
  // failing, every tab retried twenty times a minute, and those retries were themselves
  // requests against the budget that was already exhausted. The failure generated the load
  // that sustained the failure. Nothing in that loop could ever decide to stop.
  //
  // Backoff is 3/6/12/24/48 capped at 60s, and after WS_MAX_ATTEMPTS it stops for good and
  // says so. The 3s poll above remains the correctness guarantee, so giving up on the
  // socket costs latency, never correctness.
  var WS_BACKOFF_MS=[3000,6000,12000,24000,48000], WS_CAP_MS=60000, WS_MAX_ATTEMPTS=8;
  var wsAttempts=0, wsTimer=null, wsSock=null, wsGaveUp=false;

  function closeSocket(){
    if(wsTimer!==null){ clearTimeout(wsTimer); wsTimer=null; }
    if(wsSock){ try{ wsSock.onclose=null; wsSock.close(); }catch(x){} wsSock=null; }
  }

  function wsGiveUp(){
    if(wsGaveUp) return;
    wsGaveUp=true;
    closeSocket();
    var n=el('wsNotice');
    if(n){ n.textContent='Connection lost — reload to reconnect.'; n.hidden=false; }
  }

  function connectWS(){
    // §C — never reconnect on a closed event. The old loop had no idea the event had ended,
    // so it kept dialling for something that would never send again.
    if(pollStopped||wsGaveUp) return;
    if(wsAttempts>=WS_MAX_ATTEMPTS){ wsGiveUp(); return; }
    try{
      var wsUrl=base.replace(/^http/,'ws')+'/v1/c/'+CFG.eventId+'/subscribe'+q;
      var ws=new WebSocket(wsUrl);
      wsSock=ws;
      ws.onopen=function(){ wsAttempts=0; }; // a real connection resets the ladder
      ws.onmessage=function(e){ try{ var d=JSON.parse(e.data); if(d.type==='changed'){ poll(); } }catch(x){} };
      ws.onclose=function(){
        wsSock=null;
        if(pollStopped||wsGaveUp) return;
        var delay=WS_BACKOFF_MS[Math.min(wsAttempts, WS_BACKOFF_MS.length-1)];
        if(delay>WS_CAP_MS) delay=WS_CAP_MS;
        // JITTER (§C). Without it every tab that lost the socket at the same moment — which
        // is what a quota breach or a deploy causes — retries in lockstep, so the recovering
        // Worker is hit by a synchronised wave instead of a spread. +/-25%.
        delay=Math.round(delay*(0.75+Math.random()*0.5));
        wsAttempts++;
        if(wsAttempts>=WS_MAX_ATTEMPTS){ wsGiveUp(); return; }
        wsTimer=setTimeout(connectWS, delay);
      };
      ws.onerror=function(){ try{ws.close();}catch(x){} };
    }catch(x){ /* the poll above covers push being unavailable */ }
  }
  connectWS();

  // ---- SSE enhancement (lower latency); polling remains the guarantee ----
  //
  // Brief 50 §E — THESE USED TO CLOSE PERMANENTLY ON THE FIRST ERROR.
  //
  // es.onerror = function(){ es.close(); } — one transient failure and a coordinator watching a
  // live incident silently lost the low-latency path for the rest of the event. The poll still
  // covered them, so nothing looked broken; the stream just went quiet, which is the exact shape
  // §E calls worse than reporting stopped.
  //
  // Same ladder the socket already uses (Brief 33 Fix A §C): bounded attempts, capped delay,
  // ±25% jitter so tabs that dropped together — which is what a deploy or a quota breach causes —
  // do not retry in lockstep against a Worker that is still recovering. And it never reconnects
  // to a closed event.
  function sseWithBackoff(path, stateId, onData){
    var attempts=0, src=null, timer=null;
    function open(){
      if(pollStopped){ setState(stateId,'stopped','STOPPED — event closed'); return; }
      if(attempts>=WS_MAX_ATTEMPTS){ setState(stateId,'stopped','STOPPED — using poll only'); return; }
      try{
        src=new EventSource(api(path));
        src.onopen=function(){ attempts=0; setState(stateId,'live','LIVE'); };
        src.onmessage=function(e){ try{ onData(JSON.parse(e.data)); }catch(x){} };
        src.onerror=function(){
          try{ src.close(); }catch(x){}
          src=null;
          if(pollStopped){ setState(stateId,'stopped','STOPPED — event closed'); return; }
          var delay=WS_BACKOFF_MS[Math.min(attempts, WS_BACKOFF_MS.length-1)];
          if(delay>WS_CAP_MS) delay=WS_CAP_MS;
          delay=Math.round(delay*(0.75+Math.random()*0.5));
          attempts++;
          setState(stateId,'degraded','DEGRADED — reconnecting');
          if(attempts>=WS_MAX_ATTEMPTS){ setState(stateId,'stopped','STOPPED — using poll only'); return; }
          timer=setTimeout(open, delay);
        };
      }catch(x){ setState(stateId,'stopped','STOPPED — unavailable'); }
    }
    open();
    return function(){ if(timer) clearTimeout(timer); if(src){ try{src.close();}catch(x){} } };
  }

  try{
    sseWithBackoff('/audio/stream','audioState',function(d){ if(window.__pumpAudio) window.__pumpAudio(d.latestSequence); });
    sseWithBackoff('/location/stream','locationState',function(d){
      if(d.location){ lastLoc=d.location; lastTrail=d.trail||lastTrail; applyLocation(d.location,lastTrail); }
    });
  }catch(x){}

  // ---- coordinator secures (Brief 12 P2): a single, deliberate confirm step.
  // No pin entry — the coordinator never types the user's code; they review the
  // PIN sat/unsat status and confirm. This is also the only "responding" claim:
  // coordination was already claimed by the deliberate Take-coordination POST,
  // so there is no second "I am responding" affordance here. ----
  var secureAlert=el('secureAlert');
  if(secureAlert){
    function postSecure(body){
      return fetch(api('/secure'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){ return r.json().then(function(d){ return {status:r.status,d:d}; }); });
    }
    function relabel(){ return (S.closure&&S.closure.requested)?'CONFIRM CLOSURE — END ALERT':'REQUEST CLOSURE'; }
    function handleSecure(res){
      var d=res.d;
      if(d&&d.secured){ secureAlert.textContent='SECURED ✓'; return; }
      // §2: coordinator initiated; the user hasn't assented yet. Queued, not closed.
      if(d&&d.queued&&d.awaitingUser){ secureAlert.disabled=true; secureAlert.textContent='CLOSURE REQUESTED — AWAITING USER'; return; }
      // §E4: a TAMPERING event never clean-closes. The coordinator must override
      // with an explicit, logged reason that they have confirmed the user is safe.
      if(res.status===409 && d && d.error==='tampering_requires_override'){
        var reason=window.prompt('TAMPERING: repeated duress signals on this event. Do NOT assume safe. To secure anyway, type the reason you have confirmed the user is genuinely safe (this is logged):');
        if(reason && reason.trim()){ secureAlert.textContent='SECURING…'; postSecure({override:true, overrideReason:reason.trim()}).then(handleSecure); }
        else { secureAlert.disabled=false; secureAlert.textContent=relabel(); }
        return;
      }
      secureAlert.disabled=false; secureAlert.textContent=relabel(); alert('Could not complete that. Try again.');
    }
    secureAlert.onclick=function(){
      if(secureAlert.disabled){ return; }
      var pending = !!(S.closure&&S.closure.requested);
      var msg = pending
        ? 'Confirm closure? The user has requested it; confirming ends the alert and stops recording.'
        : 'Request closure? This is your assent — the alert ends only once the user also confirms with their gesture.';
      if(!window.confirm(msg)){ return; }
      secureAlert.disabled=true; secureAlert.textContent='SECURING…';
      postSecure({}).then(handleSecure).catch(function(){ secureAlert.disabled=false; secureAlert.textContent=relabel(); });
    };
  }
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
