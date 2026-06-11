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

import type { ContactState } from '../lib/contact-state';

interface DashboardOpts {
  eventId: string;
  token: string;
  base: string;
  state: ContactState;
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

function classificationHtml(state: ContactState): string {
  const c = state.latestClassification;
  if (!c?.summary) {
    return '<div class="muted">Building situational summary…</div>';
  }
  const threat = c.threatLevel ? c.threatLevel.toUpperCase() : '—';
  return (
    `<div class="summary">${escapeHtml(c.summary)}</div>` +
    `<div class="threat-row"><span class="muted-label">Threat</span><span class="threat-val">${escapeHtml(threat)}</span></div>`
  );
}

function clock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const m = Math.floor(t / 60)
    .toString()
    .padStart(2, '0');
  const s = (t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function renderDashboardPage(opts: DashboardOpts): string {
  const { eventId, token, base, state } = opts;
  const cfg = {
    eventId,
    token,
    base,
    zoom: ZOOM,
    tile: TILE,
    emergency: state.emergency,
  };
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
  <div class="brand">BLACK BOX · Live</div>

  <div class="bar">
    <div class="rec" id="rec">${recording}</div>
    <div class="elapsed" id="elapsed">${clock(state.durationMs)}</div>
  </div>

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

  <section class="sec">
    <div class="label">Audio · Live</div>
    <audio id="audio" class="audio" preload="auto"></audio>
    <button id="audioStart" class="audio-start" hidden>Tap to start audio</button>
    <div class="muted" id="audioNote"></div>
  </section>

  <section class="sec">
    <div class="label">Live transcript</div>
    <div class="transcript" id="transcript">${transcriptHtml(state)}</div>
  </section>

  <section class="sec">
    <div class="label">Summary</div>
    <div id="classification">${classificationHtml(state)}</div>
  </section>

  <div class="actions">
    <button id="respond" class="btn btn-respond">I AM RESPONDING</button>
    <button id="share" class="btn btn-share">SHARE LIVE LINK</button>
    <a id="call" class="btn btn-call" href="tel:${state.emergency.police}">CALL EMERGENCY (${state.emergency.police})</a>
    <button id="standDown" class="btn btn-standdown" ${state.active ? '' : 'hidden'}>
      <span class="sd-label">HOLD 3S TO STAND DOWN</span>
      <span class="sd-fill" id="sdFill"></span>
    </button>
  </div>

  <div class="ended-banner" id="endedBanner" ${state.active ? 'hidden' : ''}>
    Session ended — recording has stopped.
  </div>
</main>
<script>window.__CFG=${JSON.stringify(cfg)};window.__STATE0=${JSON.stringify(state)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

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
.brand{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:8px}
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
.btn-standdown{background:#141414;color:#888;border:1px solid #333;position:relative;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;font-size:13px;letter-spacing:.08em}
.btn-standdown.done{color:#666}
.sd-fill{position:absolute;left:0;bottom:0;height:3px;width:0;background:#888;transition:width .05s linear}
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
  function fmt(ms){var t=Math.floor(ms/1000);var m=Math.floor(t/60);var s=t%60;return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;}
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
  function applyClassification(c){
    var node=el('classification');
    if(!c||!c.summary){return;}
    var threat=c.threatLevel?c.threatLevel.toUpperCase():'—';
    node.innerHTML='';
    var s=document.createElement('div'); s.className='summary'; s.textContent=c.summary; node.appendChild(s);
    // highlight transcript lines that match any classification category
    if(c.matchedCategories && c.matchedCategories.length){
      var lines=document.querySelectorAll('#transcript .tline');
      for(var i=0;i<lines.length;i++){ lines[i].classList.add('hit'); }
    }
    var row=document.createElement('div'); row.className='threat-row';
    row.innerHTML='<span class="muted-label">Threat</span><span class="threat-val">'+threat+'</span>';
    node.appendChild(row);
  }
  applyTranscript(S.latestTranscriptFragments);
  applyClassification(S.latestClassification);

  // ---- progressive audio (MSE) with /audio/full fallback ----
  var audio=el('audio'), note=el('audioNote'), startBtn=el('audioStart');
  var knownLatest=S.audio.latestSequence, mime=S.audio.mimeType;
  function normMime(m){ if(!m) return ''; if(m.indexOf('audio/webm')===0) return 'audio/webm; codecs="opus"'; if(m.indexOf('video/webm')===0) return 'video/webm; codecs="vp8,opus"'; return m; }
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
      var sd=el('standDown'); if(sd){ sd.hidden=true; }
    }
  }

  // ---- /state polling backbone (every 3s) ----
  function poll(){
    fetch(api('/state')).then(function(r){ return r.ok?r.json():null; }).then(function(st){
      if(!st) return;
      durationMs=st.durationMs; baseNow=Date.now();
      if(st.location){ lastLoc=st.location; lastTrail=st.trail; applyLocation(st.location, st.trail); }
      applyTranscript(st.latestTranscriptFragments);
      applyClassification(st.latestClassification);
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

  // ---- action buttons ----
  el('respond').onclick=function(){
    var b=el('respond');
    fetch(api('/responding'),{method:'POST'}).then(function(){ b.classList.add('done'); b.textContent='RESPONDING ✓'; }).catch(function(){});
  };
  el('share').onclick=function(){
    var b=el('share');
    fetch(api('/share')).then(function(r){ return r.json(); }).then(function(d){
      if(d&&d.url&&navigator.clipboard){ navigator.clipboard.writeText(d.url).then(function(){ b.textContent='LINK COPIED'; setTimeout(function(){ b.textContent='SHARE LIVE LINK'; },2000); }); }
      else if(d&&d.url){ window.prompt('Copy this live link', d.url); }
    }).catch(function(){});
  };

  // ---- stand down (3s deliberate hold) ----
  (function(){
    var btn=el('standDown'); if(!btn) return;
    var fill=el('sdFill'); var label=btn.querySelector('.sd-label');
    var HOLD=3000, raf=null, start=0, done=false;
    function reset(){ if(raf){ cancelAnimationFrame(raf); raf=null; } start=0; fill.style.width='0%'; }
    function complete(){
      done=true; reset(); btn.classList.add('done');
      if(label){ label.textContent='STOOD DOWN'; }
      fetch(api('/stand-down'),{method:'POST'}).catch(function(){});
    }
    function tick(now){
      if(!start) return;
      var p=Math.min((now-start)/HOLD,1);
      fill.style.width=(p*100)+'%';
      if(p>=1){ if(!done){ complete(); } return; }
      raf=requestAnimationFrame(tick);
    }
    btn.addEventListener('pointerdown',function(e){ e.preventDefault(); if(done) return; start=performance.now(); raf=requestAnimationFrame(tick); });
    function release(){ if(done) return; reset(); }
    btn.addEventListener('pointerup',release);
    btn.addEventListener('pointerleave',release);
    btn.addEventListener('pointercancel',release);
  })();
})();
`;
