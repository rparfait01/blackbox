/**
 * Recipient registration page (Fix Brief 2 #C1). Served in place of the evidence
 * dashboard the first time a token is claimed, until the recipient has registered
 * and verified an identity. No anonymous access to evidence, ever.
 *
 * Self-contained: inline CSS + inline JS posting to the JSON register/verify
 * endpoints, then reloading into the dashboard once verified.
 */

interface Opts {
  eventId: string;
  token: string;
  base: string;
}

export function renderRecipientRegistration(opts: Opts): string {
  const cfg = { eventId: opts.eventId, token: opts.token, base: opts.base };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>BLACK BOX · Verify identity</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="brand">BLACK BOX · Evidence access</div>
  <h1>Verify your identity</h1>
  <p class="lead">This is protected evidence. Before it opens, your identity is recorded and bound to this access. There is no anonymous access.</p>

  <form id="regForm" class="card">
    <label>Full name<input id="fullName" autocomplete="name" required /></label>
    <label>Agency / organization<input id="agency" autocomplete="organization" required /></label>
    <label>Role or badge reference<input id="roleRef" placeholder="optional" /></label>
    <label>Email (a code is sent here)<input id="contactValue" type="email" autocomplete="email" required /></label>
    <p class="err" id="regErr" hidden></p>
    <button type="submit" id="regBtn">Send verification code</button>
  </form>

  <form id="verifyForm" class="card" hidden>
    <p class="lead">Enter the 6-digit code sent to your email.</p>
    <label>Code<input id="code" inputmode="numeric" maxlength="6" placeholder="------" /></label>
    <p class="err" id="verErr" hidden></p>
    <button type="submit" id="verBtn">Verify &amp; open evidence</button>
  </form>

  <p class="fine">Recorded: name, agency, role, contact, verification status, and first-seen time (UTC). Every action you take on this evidence is logged against your recipient ID.</p>
</main>
<script>window.__CFG=${JSON.stringify(cfg)};</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#e8e8e8;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:480px;margin:0 auto;padding:28px 18px 48px}
.brand{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:14px}
h1{font-size:22px;font-weight:600;margin-bottom:8px}
.lead{color:#aaa;font-size:14px;line-height:1.5;margin-bottom:18px}
.card{display:flex;flex-direction:column;gap:12px;border:1px solid #333;border-radius:10px;padding:16px;margin-bottom:16px}
label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#999}
input{background:#111;border:1px solid #333;border-radius:6px;color:#e8e8e8;padding:12px;font-size:16px}
button{background:#ff3b30;color:#fff;border:0;border-radius:8px;padding:15px;font-weight:700;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}
.err{color:#ff6b60;font-size:13px}
.fine{color:#666;font-size:11px;line-height:1.5}
`;

const JS = `
(function(){
  var CFG=window.__CFG, q='?t='+encodeURIComponent(CFG.token);
  function api(p){return CFG.base+'/v1/c/'+CFG.eventId+p+q;}
  function el(id){return document.getElementById(id);}
  function show(id,msg){var e=el(id);e.textContent=msg;e.hidden=false;}
  el('regForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    el('regErr').hidden=true; var b=el('regBtn'); b.disabled=true; b.textContent='Sending…';
    fetch(api('/recipient/register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      fullName:el('fullName').value,agency:el('agency').value,roleRef:el('roleRef').value,
      contactType:'email',contactValue:el('contactValue').value,scope:'dispatch'
    })}).then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});}).then(function(res){
      b.disabled=false; b.textContent='Send verification code';
      if(res.ok){ el('regForm').hidden=true; el('verifyForm').hidden=false; }
      else { show('regErr', res.d&&res.d.error?res.d.error:'Could not start verification.'); }
    }).catch(function(){ b.disabled=false; b.textContent='Send verification code'; show('regErr','Network error.'); });
  });
  el('verifyForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    el('verErr').hidden=true; var b=el('verBtn'); b.disabled=true; b.textContent='Verifying…';
    fetch(api('/recipient/verify'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:el('code').value})})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});}).then(function(res){
      if(res.ok){ window.location.reload(); }
      else { b.disabled=false; b.textContent='Verify & open evidence'; show('verErr', res.d&&res.d.error?res.d.error:'Invalid code.'); }
    }).catch(function(){ b.disabled=false; b.textContent='Verify & open evidence'; show('verErr','Network error.'); });
  });
})();
`;
