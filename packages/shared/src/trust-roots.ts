/**
 * Signer trust roots (Brief 39) — the answer to "who vouched for this document?".
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS CLOSES. The export carried the signing public key alongside the signed
 * material, and verification used the key it was handed:
 *
 *     verifyReportSignature(canonicalize(attestation), payload.signature, payload.publicKey)
 *
 * That check is circular. Anyone able to produce a package can generate a keypair, sign with
 * it, bundle the public half, and obtain VERIFIED. Nothing in the output named WHO signed, so
 * a reviewer reading a verified export learned that the bytes were internally consistent —
 * not that they came from this system. Briefs 37 and 38 made the chain correct and complete;
 * without this, correctness and completeness were properties of a document with no origin.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * §0 — WHERE THE TRUST ROOT LIVES, AND WHAT THAT COSTS.
 *
 * This set is EMBEDDED AT BUILD TIME in the verifier, and it is authoritative. A well-known
 * endpoint (`/.well-known/blackbox-trust-roots.json`) serves the same set for ROTATION
 * DISCOVERY only — so an operator can see that a key has been added or retired — and it is
 * never consulted as authority. There is no dynamic fetch that can widen this set.
 *
 * THE RESIDUAL ASSUMPTION, STATED PLAINLY: pinning does not eliminate trust, it RELOCATES it
 * from the package to the verifier artifact. A reviewer who runs a substituted verifier
 * binary gets whatever that binary chooses to trust. That is why §E publishes the verifier
 * with a checksum and why every run prints this set's version before any result: the
 * checksum is the reviewer's entry point into exactly this assumption. Claiming the
 * assumption is gone would be the same class of overclaim Brief 38 §B had to correct.
 *
 * WHAT THIS DOES NOT ANSWER. Whether the operator could sign a FABRICATED package with a
 * genuinely trusted key. That is an operator-trust question, not a cryptographic one, and it
 * is answered — to the extent it is answered at all — by the zero-knowledge custody model
 * (the server holds no key that opens a survivor's capture), not by anything here. This
 * module establishes that a signature came from a key this project published. It does not,
 * and cannot, establish that the signer was honest.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every key below is ALREADY PUBLIC — they are served at the well-known endpoints and
 * embedded in the standalone verifier. Nothing secret is committed here.
 */

/** Bump on ANY change to the set. Printed before every verification result (§E). */
export const TRUST_SET_VERSION = '2026-07-31.1';

export interface TrustedSigner {
  /** sha256 of the SPKI bytes, hex, `sha256:`-prefixed. The reviewer-facing identity. */
  fingerprint: string;
  /** SPKI, base64. The verifier uses THIS copy, never the one inside the package. */
  spki: string;
  algorithm: 'ECDSA-P256-SHA256' | 'Ed25519';
  /** What this key signs, so a report key cannot vouch for a custody manifest. */
  role: 'report' | 'integrity';
  /** Human label for the output line. */
  label: string;
  environment: 'production' | 'staging';
  /** Signatures made from this instant are in-window. */
  validFrom: number;
  /** ROTATION: retired, but signatures made before this instant still verify (§C). */
  validUntil: number | null;
  /** REVOCATION: compromised. Signatures made AFTER this instant do not verify (§C). */
  revokedAt: number | null;
  revokedReason: string | null;
}

/**
 * THE SET. Version-controlled and reviewable by construction: changing it is a reviewed code
 * change, not a config edit, and the diff shows exactly which key moved and why.
 *
 * Rotation and revocation are recorded separately as operator actions in the audit log
 * (POST /v1/admin/trust/record) with actor, timestamp and reason — the audit row is the
 * operational record, this file is the enforced state, and they are expected to agree.
 */
export const TRUSTED_SIGNERS: readonly TrustedSigner[] = [
  {
    fingerprint: 'sha256:d5b8a0861449c698059e21cf06e28f354526bc77e0069225857ba2afae02fea2',
    spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXqmajlR2iQOxIrPfF4AE8kTQdfofQIlLWaZn39L2mxyq2mwbcCb32QvqrNzQsTVHnBR1l3j9+0c/7nmbydR+GQ==',
    algorithm: 'ECDSA-P256-SHA256',
    role: 'report',
    label: 'BLACK BOX report signing key (production)',
    environment: 'production',
    validFrom: 0,
    validUntil: null,
    revokedAt: null,
    revokedReason: null,
  },
  {
    fingerprint: 'sha256:e458ef3385f7215d9375bad67fc41f3922542f9fbb3edab69b37d8c1d2f90831',
    spki: 'MCowBQYDK2VwAyEA0JvR9tHYACGq0mivDWifJ16CJ6mt6t5A06yLlhpwPYE=',
    algorithm: 'Ed25519',
    role: 'integrity',
    label: 'BLACK BOX custody/integrity key (production)',
    environment: 'production',
    validFrom: 0,
    validUntil: null,
    revokedAt: null,
    revokedReason: null,
  },
  {
    fingerprint: 'sha256:80a8ce8d025f358c1fa6afd5c4fbba83a28054c012a42057ca2c462788e7428d',
    spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEINaqxgJsApfosM1lTPKROXU0fzIwknZNfzUbdTBPpAvgwKm/YoNM1zFWBP0qIcIKzKfLtPZPc4xf8v+31vNMCw==',
    algorithm: 'ECDSA-P256-SHA256',
    role: 'report',
    label: 'BLACK BOX report signing key (staging)',
    environment: 'staging',
    validFrom: 0,
    validUntil: null,
    revokedAt: null,
    revokedReason: null,
  },
  {
    fingerprint: 'sha256:f416bea188f1d60e1d90b9ac0bace8dd8a50457dc628ee60ce3d68ea59e0018e',
    spki: 'MCowBQYDK2VwAyEAukhg3BBMXLS4wV0A0Lxw46kIakd9sXOaL4lp/V6eHwQ=',
    algorithm: 'Ed25519',
    role: 'integrity',
    label: 'BLACK BOX custody/integrity key (staging)',
    environment: 'staging',
    validFrom: 0,
    validUntil: null,
    revokedAt: null,
    revokedReason: null,
  },
];

/** §D — signer provenance, a FOURTH axis. Independent of Brief 37's chain outcome, Brief
 *  38's completeness state, and Brief 36's encryption state. Never folded into any of them. */
export type SignerOutcome = 'SIGNER_TRUSTED' | 'SIGNER_UNKNOWN' | 'SIGNER_REVOKED' | 'SIGNATURE_INVALID';

export interface SignerVerdict {
  outcome: SignerOutcome;
  /** The fingerprint of the key PRESENTED by the package, whether trusted or not. */
  fingerprint: string;
  /** Populated only when the fingerprint matched the set. */
  signer: TrustedSigner | null;
  signedAt: number | null;
  /** Was the matched key inside its validity window at the signing instant? */
  validAtSigningTime: boolean;
  /** §B — a plain-language line a reviewer can read and act on. */
  statement: string;
  trustSetVersion: string;
}

function toBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The fingerprint of an UNPARSEABLE key. It matches nothing in the trust set, which is the
 * correct outcome: a key we cannot even decode is certainly not one we published.
 */
export const UNPARSEABLE_FINGERPRINT = 'sha256:unparseable';

/**
 * sha256 of the SPKI bytes, hex, `sha256:`-prefixed.
 *
 * NEVER THROWS. This runs on bytes supplied by the document under examination, which may be
 * malformed by accident or deliberately — a verifier that crashes on a hostile package is a
 * verifier that can be denied. Garbage in yields a fingerprint that matches nothing.
 */
export async function fingerprintSpki(spkiB64: string): Promise<string> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(spkiB64) as BufferSource));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return `sha256:${hex}`;
  } catch {
    return UNPARSEABLE_FINGERPRINT;
  }
}

/** Look up a presented key by fingerprint. Returns null when it is not ours. */
export function findSigner(
  fingerprint: string,
  role?: TrustedSigner['role'],
  set: readonly TrustedSigner[] = TRUSTED_SIGNERS,
): TrustedSigner | null {
  return set.find((s) => s.fingerprint === fingerprint && (role === undefined || s.role === role)) ?? null;
}

/**
 * §A/§C/§D — decide the signer axis.
 *
 * `signatureValid` must have been computed against the TRUST SET's copy of the key, never
 * the bytes inside the package. This function does not perform the cryptography; it decides
 * what the result MEANS, and it is deliberately separate so the ordering of the outcomes is
 * readable in one place.
 *
 * Order matters. SIGNATURE_INVALID is decided before anything else can excuse it: a
 * signature that does not verify is not made better by the key being one of ours.
 */
export function evaluateSigner(input: {
  fingerprint: string;
  signatureValid: boolean | null;
  signedAt: number | null;
  role?: TrustedSigner['role'];
  /**
   * EXPLICIT override, for tests and for embedding a different deployment's roots. Defaults
   * to the pinned set, which is the load-bearing difference from the pin this replaces:
   * that one was optional, so FORGETTING it meant no trust check at all and every caller
   * except the verification page self-verified. Here, omission means the full pinned check
   * and widening trust requires writing it at the call site, where a reviewer can see it.
   * `trust-provenance.guard.test.ts` pins that no production call site passes this.
   */
  trustedSigners?: readonly TrustedSigner[];
}): SignerVerdict {
  const { fingerprint, signatureValid, signedAt } = input;
  const signer = findSigner(fingerprint, input.role, input.trustedSigners ?? TRUSTED_SIGNERS);
  const base = { fingerprint, signer, signedAt, trustSetVersion: TRUST_SET_VERSION };

  if (!signer) {
    // THE EXACT CONDITION THE DEFECT ALLOWED TO PASS AS VERIFIED. A package that brought its
    // own key and signed itself lands here, and it must be impossible to mistake for a pass.
    return {
      ...base,
      outcome: 'SIGNER_UNKNOWN',
      validAtSigningTime: false,
      statement:
        `This document was signed by a key BLACK BOX does not publish (${fingerprint}). ` +
        'It may be internally consistent, but nothing establishes that it came from this system.',
    };
  }
  if (signatureValid !== true) {
    return {
      ...base,
      outcome: 'SIGNATURE_INVALID',
      validAtSigningTime: false,
      statement: `The signature does not verify against ${signer.label} (${fingerprint}).`,
    };
  }
  // REVOCATION (§C): signatures made AFTER the revocation instant do not verify; those made
  // before it stand, with an explicit notice. A key being compromised today does not make
  // last year's export a forgery.
  if (signer.revokedAt != null && signedAt != null && signedAt >= signer.revokedAt) {
    return {
      ...base,
      outcome: 'SIGNER_REVOKED',
      validAtSigningTime: false,
      statement:
        `Signed by ${signer.label} (${fingerprint}) AFTER that key was revoked` +
        `${signer.revokedReason ? ` — ${signer.revokedReason}` : ''}. This signature is not trusted.`,
    };
  }
  // ROTATION (§C): a retired key still verifies what it signed while it was live. A
  // survivor's export from a year ago must not stop verifying because a key rotated.
  const inWindow =
    (signedAt == null || signedAt >= signer.validFrom) &&
    (signer.validUntil == null || (signedAt != null && signedAt <= signer.validUntil));
  const retiredNotice =
    signer.validUntil != null ? ' That key has since been retired; this signature predates its retirement.' : '';
  const revokedNotice =
    signer.revokedAt != null ? ' That key was later revoked; this signature predates the revocation.' : '';

  if (!inWindow) {
    return {
      ...base,
      outcome: 'SIGNER_REVOKED',
      validAtSigningTime: false,
      statement: `Signed by ${signer.label} (${fingerprint}) outside that key's validity window.`,
    };
  }
  return {
    ...base,
    outcome: 'SIGNER_TRUSTED',
    validAtSigningTime: true,
    statement:
      `Signed by ${signer.label}, fingerprint ${fingerprint}` +
      `${signedAt != null ? `, at ${new Date(signedAt).toISOString()}` : ''}.` +
      retiredNotice +
      revokedNotice,
  };
}
