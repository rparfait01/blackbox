/**
 * The verifier (Brief 29 §3).
 *
 * Read-only, stateless, and deliberately narrow. It checks ONE signed artifact — this
 * document — and nothing else. It does not re-verify captures, events, custody, or
 * anything the platform already attests internally, and nothing in the running system
 * calls it, imports it, or changes because of it (§-1 [A]). Delete it tomorrow and the app
 * is unchanged; documents stay verifiable by the published key.
 *
 * IT NEVER STORES WHAT IT IS GIVEN. The document arrives as a string argument, is hashed
 * and checked, and goes out of scope. There is no write, no upload, no cache, no database
 * call, and no logging of content anywhere in this module — report-leaf.guard.test.ts pins
 * that structurally so it stays true.
 *
 * FOUR OUTCOMES, AND WHY 'unverifiable' EXISTS. A verifier that cannot tell "unaltered"
 * from "I couldn't check" is worse than none: it would print CERTIFIED on faith. If the
 * runtime has no Ed25519, we say so and point to the published key + algorithm so a court's
 * own expert can check it elsewhere. We never guess in the reassuring direction.
 */
import { canonicalize, canonicalHash, renderedHash } from './canonical';
import { parseReportDocument, renderEvidenceText } from './report-document';
import type { ReportAttestation } from './report';

export type Verdict = 'certified' | 'tampered' | 'not_a_report' | 'unverifiable';

export interface VerificationChecks {
  signatureValid: boolean;
  evidenceHashMatches: boolean;
  renderedTextMatches: boolean;
  /** The visible text re-rendered from the SIGNED data agrees with the file's text. */
  renderingConsistent: boolean;
}

export interface VerificationResult {
  verdict: Verdict;
  /** Reader-facing headline, in the wording §3 specifies. */
  headline: string;
  detail: string;
  /** Which individual checks passed. Present whenever the file parsed. */
  checks?: VerificationChecks;
  attestation?: ReportAttestation;
  /** The evidence text re-rendered from the signed JSON — what BLACK BOX actually signed,
   *  shown so a reader compares it against the document rather than trusting the markup. */
  signedEvidenceText?: string;
  /** Reported separately and NEVER flagged as tampered for having been edited (§3). */
  statement?: { present: boolean; note: string };
}

export const STATEMENT_NOTE = 'Survivor statement — her account, not machine-verified';
export const CERTIFIED_PREFIX = 'BLACK BOX CERTIFIED — evidence verified, unaltered since generation';
export const TAMPERED_HEADLINE =
  'TAMPERED — this document’s evidence has been altered and is not certified by BLACK BOX.';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ed25519 verify. Returns null — NOT false — when the runtime cannot do Ed25519 at all,
 *  so "I can't check this" is never reported as "this failed". */
export async function verifyEd25519(
  data: string,
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean | null> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', b64ToBytes(publicKeyB64) as BufferSource, { name: 'Ed25519' }, false, [
      'verify',
    ]);
  } catch {
    return null; // no Ed25519 here (or an unusable key) — unverifiable, not invalid
  }
  try {
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      b64ToBytes(signatureB64) as BufferSource,
      new TextEncoder().encode(data) as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Verify a certified report document.
 *
 * @param html               the file's contents
 * @param expectedPublicKey  optional pin. When supplied, the document's own key must equal
 *                           it — otherwise a forger could ship a document signed with their
 *                           own key AND the matching public key, and it would self-verify.
 *                           The verification page always pins the published BLACK BOX key.
 */
export async function verifyReportDocument(html: string, expectedPublicKey?: string): Promise<VerificationResult> {
  const parsed = parseReportDocument(html);
  if (!parsed) {
    return {
      verdict: 'not_a_report',
      headline: 'Not a BLACK BOX certified report',
      detail: 'This file does not contain a BLACK BOX evidence record, so there is nothing to verify.',
    };
  }

  const { payload, evidenceText, statement } = parsed;
  const { attestation } = payload;
  const signedEvidenceText = renderEvidenceText(payload.evidence);
  const statementInfo = { present: statement.trim().length > 0, note: STATEMENT_NOTE };

  if (expectedPublicKey && payload.publicKey !== expectedPublicKey) {
    return {
      verdict: 'tampered',
      headline: TAMPERED_HEADLINE,
      detail:
        'The document is signed with a key that is not the published BLACK BOX signing key. A document that carries its own key proves nothing.',
      checks: {
        signatureValid: false,
        evidenceHashMatches: false,
        renderedTextMatches: false,
        renderingConsistent: false,
      },
      attestation,
      signedEvidenceText,
      statement: statementInfo,
    };
  }

  // 1. The embedded evidence JSON must hash to what was signed.
  const evidenceHashMatches = (await canonicalHash(payload.evidence)) === attestation.evidenceHash;
  // 2. The VISIBLE text must hash to what was signed — editing what a reader sees is caught.
  const fileTextHash = await renderedHash(evidenceText);
  const renderedTextMatches = fileTextHash === attestation.renderedHash;
  // 3. The visible text must be what the signed data actually renders to — so a document
  //    cannot show one thing while carrying another.
  const renderingConsistent = (await renderedHash(signedEvidenceText)) === fileTextHash;
  // 4. The signature over the attestation must check out against the published key.
  const signatureValid = await verifyEd25519(canonicalize(attestation), payload.signature, payload.publicKey);

  const checks: VerificationChecks = {
    signatureValid: signatureValid === true,
    evidenceHashMatches,
    renderedTextMatches,
    renderingConsistent,
  };

  if (signatureValid === null) {
    return {
      verdict: 'unverifiable',
      headline: 'Could not verify here',
      detail:
        'This runtime cannot perform Ed25519 verification, so we will not tell you either way. Verify the signature with the published BLACK BOX public key and algorithm shown in the document, using your own tooling.',
      checks,
      attestation,
      signedEvidenceText,
      statement: statementInfo,
    };
  }

  if (signatureValid && evidenceHashMatches && renderedTextMatches && renderingConsistent) {
    return {
      verdict: 'certified',
      headline: `${CERTIFIED_PREFIX} ${attestation.signedAt}.`,
      detail:
        'The evidence section is byte-for-byte what BLACK BOX signed. The survivor statement is reported separately and is not covered by this signature.',
      checks,
      attestation,
      signedEvidenceText,
      statement: statementInfo,
    };
  }

  return {
    verdict: 'tampered',
    headline: TAMPERED_HEADLINE,
    detail: describeFailure(checks),
    checks,
    attestation,
    signedEvidenceText,
    statement: statementInfo,
  };
}

function describeFailure(checks: VerificationChecks): string {
  if (!checks.signatureValid) {
    return 'The signature does not check out against the published BLACK BOX key.';
  }
  if (!checks.evidenceHashMatches) {
    return 'The evidence record does not match the hash BLACK BOX signed — its data has been altered.';
  }
  if (!checks.renderedTextMatches) {
    return 'The visible evidence text does not match the text BLACK BOX signed — the readable record has been altered.';
  }
  return 'The visible evidence text does not match the signed data it claims to render.';
}
