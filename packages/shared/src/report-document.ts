/**
 * The certified report document (Brief 29 §1, §2, §4) — render and parse.
 *
 * SHARED, because this is the format contract: the device renders a document, the verifier
 * parses one, and if those two drifted apart every report would fail to verify. There is
 * exactly one renderer and one parser, and they live here.
 *
 * ONE self-contained HTML file. It opens in any browser, prints to PDF, and carries
 * everything a third party needs to check it — no network, no BLACK BOX, no account.
 *
 * THE TWO ZONES, AND WHY THE BOUNDARY IS WHERE IT IS (§0):
 *
 *   EVIDENCE  — system record + on-device decryption of her own capture. Signed. Any
 *               alteration is detectable. It is rendered as a <pre> block whose exact text
 *               is bound into the signature, so editing what a reader SEES is caught, not
 *               just editing the machine-readable copy.
 *   STATEMENT — her words, her context. Deliberately NOT signed, so she can revise her
 *               account without invalidating the certification, and so a court is told
 *               plainly that this part is her account and not machine-verified.
 *
 * PARSING IS DOM-FREE ON PURPOSE. The verifier must run identically in a browser, in the
 * Worker, and in a court expert's own script. Everything is extracted from unambiguous
 * markers with string search — no DOMParser, no HTML parser, no dependency.
 */
import { canonicalize, canonicalHash, renderedHash } from './canonical';
import { REPORT_DOCUMENT_FORMAT, type CertifiedReportPayload, type EvidenceZone } from './report';

export const DOCUMENT_FORMAT = REPORT_DOCUMENT_FORMAT;
export const VERIFICATION_URL = 'https://www.blackboxsentinel.com/verification';

const ATTESTATION_OPEN = '<script type="application/json" id="blackbox-attestation">';
const ATTESTATION_CLOSE = '</script>';
const EVIDENCE_OPEN = '<pre id="blackbox-evidence-text">';
const EVIDENCE_CLOSE = '</pre>';
const STATEMENT_OPEN = '<div id="blackbox-statement">';
const STATEMENT_CLOSE = '</div>';

export interface ReportDocumentInput extends CertifiedReportPayload {
  /** Her own words. Unsigned, and excluded from every hash. */
  statement: string;
}

// ---- escaping (DOM-free, reversible) ----

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeHtml(text: string): string {
  // Order matters: &amp; last, or "&amp;lt;" would round-trip wrong.
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/** JSON safe to sit inside a <script> block — only `<` needs neutralizing. */
function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c');
}

// ---- the human-readable evidence rendering ----

function line(label: string, value: string | number | boolean | null): string {
  if (value === null) return `${label}: not recorded`;
  return `${label}: ${String(value)}`;
}

/**
 * Render the evidence zone as plain text — DETERMINISTIC and a pure function of the
 * evidence JSON. That purity is what lets the verifier re-render from the signed data and
 * show a reader "this is what was actually signed", instead of trusting the file's markup.
 *
 * No sentence here characterizes the incident. Every line is a recorded fact or an
 * arithmetic derivation of one (§1 [A] — no AI in the evidence zone).
 */
export function renderEvidenceText(evidence: EvidenceZone): string {
  const out: string[] = [];
  out.push('BLACK BOX — CERTIFIED EVIDENCE RECORD');
  out.push(`Evidence format version: ${evidence.formatVersion}`);
  out.push(`Generated (UTC): ${evidence.generatedAt}`);
  out.push('');
  out.push('All times are UTC (ISO 8601). This section is a factual system record and an');
  out.push('integrity check of the survivor’s own recording. It contains no interpretation,');
  out.push('no transcription, and no automated assessment of what occurred.');
  out.push('');

  out.push('-- EVENT --');
  const e = evidence.event;
  out.push(line('Event id', e.eventId));
  out.push(line('Opened', e.openedAt));
  out.push(line('Closed', e.closedAt));
  out.push(line('Duration (ms)', e.durationMs));
  out.push(line('Status', e.status));
  out.push(line('Closed by', e.closedBy));
  out.push(line('Device UTC offset (minutes)', e.tzOffsetMinutes));
  out.push(line('Coordinator engaged', e.coordinatorEngagedAt));
  out.push(line('Secured', e.securedAt));
  out.push(line('Escalated', e.escalatedAt));
  out.push(line('Escalation tier', e.escalationTier));
  out.push('');

  out.push('-- LOCATION --');
  if (!evidence.location.included) {
    out.push('Not included in this report.');
  } else if (evidence.location.pointCount === 0) {
    out.push('Included; no location points were recorded.');
  } else {
    out.push(line('Points', evidence.location.pointCount));
    for (const p of evidence.location.points) {
      out.push(
        `  ${p.at}  lat ${p.lat}  lon ${p.lon}  accuracy ${p.accuracyM === null ? 'unknown' : `${p.accuracyM} m`}`,
      );
    }
  }
  out.push('');

  out.push('-- NOTIFICATIONS --');
  if (!evidence.notifications.included) {
    out.push('Not included in this report.');
  } else if (evidence.notifications.count === 0) {
    out.push('Included; no notification records.');
  } else {
    out.push(line('Records', evidence.notifications.count));
    for (const n of evidence.notifications.records) {
      out.push(`  ${n.at}  ${n.kind}  via ${n.channel}  ${n.status}`);
    }
  }
  out.push('');

  out.push('-- CAPTURE --');
  const c = evidence.capture;
  if (!c.included) {
    out.push('Not included in this report.');
  } else {
    out.push(line('Chunks', c.chunkCount));
    out.push(line('Total bytes', c.totalBytes));
    out.push(line('First chunk', c.firstChunkAt));
    out.push(line('Last chunk', c.lastChunkAt));
    out.push(line('Final-chunk marker present', c.finalChunkPresent));
    if (!c.finalChunkPresent) {
      out.push('  NOTE: no final-chunk marker. The end of this recording may be incomplete.');
    }
    out.push(line('Chunks matching their capture-time commitment', c.chunksVerified));
    out.push(line('Chunks FAILING their capture-time commitment', c.chunksFailed));
    out.push('');
    out.push('  seq  recorded (UTC)              bytes  enc  commitment (sha256 of plaintext)  match');
    for (const ch of c.chunks) {
      const match = ch.commitmentVerified === null ? 'n/a' : ch.commitmentVerified ? 'yes' : 'NO';
      const commitment = ch.commitment ?? 'none recorded';
      out.push(
        `  ${String(ch.sequence).padStart(4)}  ${ch.recordedAt}  ${String(ch.bytes).padStart(7)}  ${
          ch.wasEncrypted ? 'y' : 'n'
        }    ${commitment}  ${match}`,
      );
    }
  }
  out.push('');

  out.push('-- CUSTODY --');
  out.push(line('Commitments on record', evidence.custody.commitmentCount));
  out.push(line('Commitments hash', evidence.custody.commitmentsHash));
  out.push(line('Envelope algorithm', evidence.custody.algorithm));
  out.push('');
  out.push('A "commitment" is the SHA-256 of a recording chunk taken ON THE DEVICE BEFORE');
  out.push('encryption, and recorded by BLACK BOX at the moment of capture. "match: yes"');
  out.push('means the chunk decrypted on the survivor’s device hashes to exactly the value');
  out.push('BLACK BOX recorded at capture time — the content has not changed since.');
  return out.join('\n');
}

/** The device-side hashes that go into the attestation request. */
export async function computeEvidenceHashes(
  evidence: EvidenceZone,
): Promise<{ evidenceHash: string; renderedHash: string }> {
  return {
    evidenceHash: await canonicalHash(evidence),
    renderedHash: await renderedHash(renderEvidenceText(evidence)),
  };
}

// ---- the document ----

const STYLE = `
:root{color-scheme:light}
body{margin:0;padding:2rem;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .25rem}
.mark{display:inline-block;border:2px solid #0a6;color:#065;padding:.35rem .75rem;border-radius:.35rem;font-weight:700;letter-spacing:.04em}
.zone{border:1px solid #ccd;border-radius:.5rem;padding:1rem 1.25rem;margin:1.25rem 0}
.zone h2{font-size:1rem;margin:0 0 .5rem;text-transform:uppercase;letter-spacing:.06em}
.signed{border-color:#0a6;background:#f6fffb}
.unsigned{border-color:#ccd;background:#fafafc}
pre{white-space:pre-wrap;word-wrap:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.note{font-size:12px;color:#556}
.sig{font:11px/1.5 ui-monospace,monospace;word-break:break-all;color:#334}
a{color:#06c}
`;

/** Build the downloadable document. The statement is escaped and placed OUTSIDE every
 *  signed byte — she can edit it later and the certification still verifies (§2, §3). */
export function renderReportHtml(input: ReportDocumentInput): string {
  const payload: CertifiedReportPayload = {
    evidence: input.evidence,
    attestation: input.attestation,
    signature: input.signature,
    publicKey: input.publicKey,
  };
  const json = escapeJsonForScript(canonicalize(payload));
  const evidenceText = escapeHtml(renderEvidenceText(input.evidence));
  const statement = escapeHtml(input.statement);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BLACK BOX certified report — ${escapeHtml(input.attestation.eventId)}</title>
<meta name="generator" content="${DOCUMENT_FORMAT}">
<style>${STYLE}</style>
</head>
<body>
<main>
<p><span class="mark">BLACK BOX CERTIFIED</span></p>
<h1>Certified report</h1>
<p class="note">
  Generated ${escapeHtml(input.attestation.signedAt)} (UTC). Anyone can verify this document
  independently at <a href="${VERIFICATION_URL}">${VERIFICATION_URL}</a>, or with the published
  BLACK BOX public key and the algorithm below — the page is a convenience, the mathematics is
  the proof.
</p>

<section class="zone signed">
  <h2>Evidence — signed</h2>
  <p class="note">
    Cryptographically signed by BLACK BOX. Any alteration to the text below is detectable,
    and BLACK BOX no longer vouches for an altered document.
  </p>
  ${EVIDENCE_OPEN}${evidenceText}${EVIDENCE_CLOSE}
</section>

<section class="zone unsigned">
  <h2>Survivor statement — her account, not machine-verified</h2>
  <p class="note">
    The words below are the author's own. They are deliberately NOT covered by the signature:
    she may revise her account at any time without invalidating the certification above. This
    section is her account and has not been machine-verified.
  </p>
  ${STATEMENT_OPEN}<pre>${statement}</pre>${STATEMENT_CLOSE}
</section>

<section class="zone">
  <h2>Signature</h2>
  <p class="note">Algorithm: Ed25519 over the canonical JSON of the attestation object below (RFC 8785-style: keys sorted by code point, no insignificant whitespace).</p>
  <p class="sig"><b>Public key (SPKI, base64):</b><br>${escapeHtml(input.publicKey)}</p>
  <p class="sig"><b>Signature (base64):</b><br>${escapeHtml(input.signature)}</p>
  <p class="sig"><b>Evidence hash (SHA-256):</b><br>${escapeHtml(input.attestation.evidenceHash)}</p>
  <p class="sig"><b>Integrity chain head:</b><br>${escapeHtml(input.attestation.chainHead ?? 'not recorded')}</p>
</section>

<p class="note">
  <b>Custody:</b> this file is now in the holder's control. Its authenticity remains verifiable;
  its privacy is the holder's to manage.
</p>

${ATTESTATION_OPEN}${json}${ATTESTATION_CLOSE}
</main>
</body>
</html>
`;
}

// ---- parsing (for the verifier) ----

export interface ParsedReport {
  payload: CertifiedReportPayload;
  /** The visible evidence text, exactly as it appears in the file. */
  evidenceText: string;
  /** The visible statement text. Never part of any hash. */
  statement: string;
}

function between(source: string, open: string, close: string): string | null {
  const start = source.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = source.indexOf(close, from);
  if (end === -1) return null;
  return source.slice(from, end);
}

/** Extract the machine-readable payload and the visible zones. Returns null when the file
 *  is not a BLACK BOX certified report at all (as opposed to a tampered one). */
export function parseReportDocument(html: string): ParsedReport | null {
  const rawJson = between(html, ATTESTATION_OPEN, ATTESTATION_CLOSE);
  const evidenceText = between(html, EVIDENCE_OPEN, EVIDENCE_CLOSE);
  if (rawJson === null || evidenceText === null) return null;

  let payload: CertifiedReportPayload;
  try {
    payload = JSON.parse(rawJson.replace(/\\u003c/g, '<')) as CertifiedReportPayload;
  } catch {
    return null;
  }
  if (!payload?.attestation || !payload?.evidence || !payload?.signature || !payload?.publicKey) {
    return null;
  }

  const statementBlock = between(html, STATEMENT_OPEN, STATEMENT_CLOSE) ?? '';
  const statement = unescapeHtml(between(statementBlock, '<pre>', '</pre>') ?? '');

  return { payload, evidenceText: unescapeHtml(evidenceText), statement };
}
