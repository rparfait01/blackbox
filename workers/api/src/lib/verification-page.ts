/**
 * The public verification page (Brief 29 §3) — a LEAF.
 *
 * Nothing in the running system imports this, routes through it, or waits on it. Delete
 * this file tomorrow and BLACK BOX runs exactly as it does today; documents stay verifiable
 * by the published key, because the page is a convenience and the mathematics is the trust.
 *
 * IT NEVER RECEIVES THE DOCUMENT. Verification runs entirely in the visitor's browser: the
 * file is read with the FileReader API and checked against the published public key in
 * page script. Nothing is uploaded, so "the verifier never stores the uploaded document"
 * (§3 [A]) is not a promise we ask anyone to take on faith — there is no upload to store.
 * The page says so plainly, and report-leaf.guard.test.ts pins that no fetch/XHR/upload
 * appears in this file.
 *
 * The verification LOGIC is not re-implemented here. The page inlines the same shared
 * verifier the rest of the system uses, injected at request time by `verificationPage()`
 * from a bundled string — one implementation, three runtimes (§-1 [A]).
 */

/** The client-side script. It is the ONLY place the page does work, and it does that work
 *  locally: read file → parse → hash → verify against the pinned key → render. */
function pageScript(publicKey: string, verifierSource: string): string {
  return `
const PUBLISHED_KEY = ${JSON.stringify(publicKey)};
${verifierSource}

const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const out = document.getElementById('out');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function render(result) {
  out.textContent = '';
  const card = el('div', 'card ' + result.verdict);
  card.appendChild(el('p', 'headline', result.headline));
  card.appendChild(el('p', 'detail', result.detail));

  if (result.checks) {
    const list = el('ul', 'checks');
    const rows = [
      ['Signature valid against the published BLACK BOX key', result.checks.signatureValid],
      ['Evidence data matches the signed hash', result.checks.evidenceHashMatches],
      ['Visible evidence text matches the signed text', result.checks.renderedTextMatches],
      ['Visible text is what the signed data renders to', result.checks.renderingConsistent],
    ];
    for (const [label, ok] of rows) {
      list.appendChild(el('li', ok ? 'ok' : 'bad', (ok ? '\\u2713 ' : '\\u2717 ') + label));
    }
    card.appendChild(list);
  }

  if (result.statement) {
    const s = el('p', 'statement');
    s.textContent = result.statement.note + (result.statement.present
      ? ' \\u2014 present in this document. It is deliberately not covered by the signature, and editing it never makes a document TAMPERED.'
      : ' \\u2014 none included in this document.');
    card.appendChild(s);
  }

  if (result.signedEvidenceText) {
    const d = el('details');
    d.appendChild(el('summary', undefined, 'Show exactly what BLACK BOX signed'));
    d.appendChild(el('pre', 'signed', result.signedEvidenceText));
    card.appendChild(d);
  }
  out.appendChild(card);
}

async function handleFile(file) {
  if (!file) return;
  out.textContent = 'Checking\\u2026';
  const html = await file.text();
  try {
    render(await verifyReportDocument(html, PUBLISHED_KEY));
  } catch (e) {
    // Brief 43 §C — the verifier is now total and this is unreachable, but it stays as the last
    // line of defence and no longer lies about what happened. It used to render 'not_a_report'
    // with String(e) as the detail: a thrown TypeError was shown to a reader as a finding about
    // their document, when it was a finding about our code. A failed READ is not a verdict.
    render({
      verdict: 'unverifiable',
      headline: 'Could not complete the check on this file',
      detail: 'The check did not finish. That says nothing about whether this document is authentic — verify it against the published BLACK BOX key with your own tooling, and please report the file.',
    });
  }
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
`;
}

const STYLE = `
:root{color-scheme:light}
body{margin:0;padding:2rem 1.25rem;font:15px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#f7f8fa}
main{max-width:48rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .35rem}
.lede{color:#445;margin:0 0 1.5rem}
#drop{border:2px dashed #9aa;border-radius:.75rem;padding:2.5rem 1.5rem;text-align:center;background:#fff;cursor:pointer}
#drop.over{border-color:#0a6;background:#f2fffa}
#file{display:none}
.card{margin-top:1.5rem;border-radius:.75rem;padding:1.25rem 1.5rem;background:#fff;border:2px solid #ccd}
.card.certified{border-color:#0a6;background:#f6fffb}
.card.tampered{border-color:#c33;background:#fff6f6}
.card.unverifiable,.card.not_a_report{border-color:#c93;background:#fffdf5}
.headline{font-weight:700;margin:0 0 .5rem;font-size:1.05rem}
.detail{margin:0 0 .75rem;color:#334}
.checks{list-style:none;padding:0;margin:0 0 .75rem;font-size:13px}
.checks li{padding:.15rem 0}
.checks .ok{color:#065}
.checks .bad{color:#a22}
.statement{font-size:13px;color:#556;border-top:1px solid #e3e5ea;padding-top:.75rem;margin:0}
details{margin-top:.75rem;font-size:13px}
pre.signed{white-space:pre-wrap;word-wrap:break-word;font:11px/1.5 ui-monospace,monospace;background:#f4f5f8;padding:.75rem;border-radius:.4rem;max-height:24rem;overflow:auto}
.keybox{margin-top:2rem;font-size:12px;color:#556;background:#fff;border:1px solid #dde;border-radius:.5rem;padding:1rem 1.25rem}
.keybox code{font:11px/1.5 ui-monospace,monospace;word-break:break-all;display:block;margin-top:.35rem;color:#223}
`;

/**
 * Build the page. `verifierSource` is the bundled shared verifier, inlined so the check
 * runs locally — the visitor's file never leaves their machine.
 */
export function verificationPage(publicKey: string, verifierSource: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Verify a BLACK BOX certified report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Verify a certified report</h1>
<p class="lede">
  Drop a BLACK BOX certified report below. This page re-computes the report's evidence hash
  and checks it against BLACK BOX's published signing key. No account, and no need to
  contact BLACK BOX.
</p>

<div id="drop">
  <b>Drop the report file here</b><br>
  <span style="color:#667;font-size:13px">or click to choose a file</span>
</div>
<input type="file" id="file" accept=".html,text/html">

<div id="out"></div>

<div class="keybox">
  <p style="margin:0 0 .5rem"><b>Your file stays on your device.</b> This page reads and checks
  it in your browser. It is never uploaded, so there is nothing for BLACK BOX to store — and
  nothing for us to see. Verification is public; the contents of your document are not.</p>

  <p style="margin:.75rem 0 0"><b>Verify independently, without this page.</b> The signature is
  ECDSA P-256 with SHA-256 over the canonical JSON of the document's attestation object (keys
  sorted by Unicode code point, no insignificant whitespace), signature as raw r&#8214;s, base64. Check it against the published key with your own
  tooling — the page is a convenience, the mathematics is the proof.</p>
  <p style="margin:.5rem 0 0">Published public key (SPKI, base64):<code>${publicKey}</code></p>
</div>
</main>
<script type="module">
${pageScript(publicKey, verifierSource)}
</script>
</body>
</html>
`;
}
