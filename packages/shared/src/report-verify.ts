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
 * runtime cannot run the check, we say so and point to the published key + algorithm so a
 * court's own expert can check it elsewhere. We never guess in the reassuring direction.
 */
import { canonicalize, canonicalHash, renderedHash } from './canonical';
import {
  evaluateSigner,
  findSigner,
  fingerprintSpki,
  TRUSTED_SIGNERS,
  TRUST_SET_VERSION,
  type SignerVerdict,
  type TrustedSigner,
} from './trust-roots';
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
  /**
   * Brief 39 §D — SIGNER PROVENANCE, a fourth and independent axis. Who vouched for this
   * document, established against a trust set the verifier carries itself. Never folded
   * into `verdict`: "the bytes are unaltered" and "this came from BLACK BOX" are different
   * findings, and the defect this closes was exactly the second being inferred from the
   * first.
   */
  signer?: SignerVerdict;
  /** §E — printed before any result, so a reviewer knows what set was in force. */
  trustSetVersion: string;
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

/**
 * Verify a report signature: ECDSA P-256 / SHA-256 over `data`, signature as raw r‖s.
 *
 * Returns null — NOT false — when the runtime cannot perform the check at all (no ECDSA, or
 * an unusable key), so "I can't check this" is never reported as "this failed". P-256 is
 * universally available, so in practice this only fires on a malformed key.
 */
export async function verifyReportSignature(
  data: string,
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean | null> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'spki',
      b64ToBytes(publicKeyB64) as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return null; // unusable key / no ECDSA here — unverifiable, not invalid
  }
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
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
 * Brief 39 — THE KEY INSIDE THE PACKAGE IS NEVER THE AUTHORITY. It is parsed, fingerprinted
 * and compared against a trust set this verifier carries independently; verification then
 * runs against the TRUST SET's copy. A document that brings its own key gets SIGNER_UNKNOWN,
 * which is the exact condition that previously passed as certified.
 *
 * The old `expectedPublicKey` pin was optional, and optional was the hole: the verification
 * page passed it, and every other caller self-verified. Trust is no longer a parameter a
 * caller can forget.
 *
 * @param html the file's contents
 */
export async function verifyReportDocument(
  html: string,
  opts?: { trustedSigners?: readonly TrustedSigner[] },
): Promise<VerificationResult> {
  const parsed = parseReportDocument(html);
  if (!parsed) {
    return {
      verdict: 'not_a_report',
      headline: 'Not a BLACK BOX certified report',
      detail: 'This file does not contain a BLACK BOX evidence record, so there is nothing to verify.',
      trustSetVersion: TRUST_SET_VERSION,
    };
  }

  const { payload, evidenceText, statement } = parsed;
  const { attestation } = payload;
  const signedEvidenceText = renderEvidenceText(payload.evidence);
  const statementInfo = { present: statement.trim().length > 0, note: STATEMENT_NOTE };

  // 1. The embedded evidence JSON must hash to what was signed.
  const evidenceHashMatches = (await canonicalHash(payload.evidence)) === attestation.evidenceHash;
  // 2. The VISIBLE text must hash to what was signed — editing what a reader sees is caught.
  const fileTextHash = await renderedHash(evidenceText);
  const renderedTextMatches = fileTextHash === attestation.renderedHash;
  // 3. The visible text must be what the signed data actually renders to — so a document
  //    cannot show one thing while carrying another.
  const renderingConsistent = (await renderedHash(signedEvidenceText)) === fileTextHash;
  // 4. THE SIGNATURE, checked against a key we hold — not the one the file handed us.
  //
  //    The document's key is parsed only to identify WHICH signer is being claimed. When the
  //    fingerprint matches our set we verify against OUR copy of that key, so a package that
  //    swapped in its own bytes cannot validate itself. When it does not match we still
  //    compute whether the signature is internally consistent — a reviewer benefits from
  //    knowing "signed by someone unknown" is different from "not really signed at all" —
  //    but that computation grants no trust whatsoever.
  const presentedFingerprint = await fingerprintSpki(payload.publicKey);
  const trusted = findSigner(presentedFingerprint, 'report', opts?.trustedSigners ?? TRUSTED_SIGNERS);
  const signatureValid = await verifyReportSignature(
    canonicalize(attestation),
    payload.signature,
    trusted ? trusted.spki : payload.publicKey,
  );
  const signedAtMs = Number.isFinite(Date.parse(String(attestation.signedAt)))
    ? Date.parse(String(attestation.signedAt))
    : null;
  const signer = evaluateSigner({
    fingerprint: presentedFingerprint,
    signatureValid,
    signedAt: signedAtMs,
    role: 'report',
    trustedSigners: opts?.trustedSigners,
  });

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
        'This runtime cannot perform ECDSA P-256 verification, so we will not tell you either way. Verify the signature with the published BLACK BOX public key and algorithm shown in the document, using your own tooling.',
      checks,
      attestation,
      signedEvidenceText,
      statement: statementInfo,
      signer,
      trustSetVersion: TRUST_SET_VERSION,
    };
  }

  // §D — an untrusted signer is reported FIRST and in its own words. This is the condition
  // the defect allowed through as certified, so it gets the headline, not a footnote.
  if (signer.outcome !== 'SIGNER_TRUSTED') {
    return {
      verdict: signer.outcome === 'SIGNATURE_INVALID' ? 'tampered' : 'not_a_report',
      headline:
        signer.outcome === 'SIGNER_UNKNOWN'
          ? 'NOT CERTIFIED BY BLACK BOX — signed by an unrecognised key'
          : signer.outcome === 'SIGNER_REVOKED'
            ? 'NOT CERTIFIED — signed by a revoked BLACK BOX key'
            : TAMPERED_HEADLINE,
      detail: signer.statement,
      checks,
      attestation,
      signedEvidenceText,
      statement: statementInfo,
      signer,
      trustSetVersion: TRUST_SET_VERSION,
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
      signer,
      trustSetVersion: TRUST_SET_VERSION,
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
    signer,
    trustSetVersion: TRUST_SET_VERSION,
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
