/**
 * Server-side encryption observation (Brief 36 §B).
 *
 * "Persist the encryption state per chunk, server-side, from what the server itself
 * observes — not from a client assertion."
 *
 * WHAT THE SERVER CAN AND CANNOT PROVE, stated plainly rather than overclaimed. In a
 * zero-knowledge design the server holds no key, so it cannot verify that ciphertext
 * decrypts — that is the whole point of the design and no amount of checking changes it.
 * What it CAN verify is STRUCTURE, and structure is what distinguishes the failure that
 * actually happened:
 *
 *   - the envelope frame header the client writes (version byte ‖ 12-byte IV ‖ ct+tag), and
 *   - a well-formed pre-encryption plaintext commitment.
 *
 * Raw capture bytes do not carry those. A webm chunk starts 0x1A45DFA3 and an mp4 starts
 * with an ftyp box, so a plaintext upload cannot accidentally satisfy this check, which is
 * exactly the case this exists to catch: a client that believed it was encrypting and was
 * not. It is not a defence against a hostile client — a hostile client holds the event
 * HMAC and could fabricate a frame — and it is not claimed to be.
 *
 * The three outcomes matter differently:
 *   ENCRYPTED               conforming.
 *   UNENCRYPTED_DECLARED    plaintext, and the client SAID so. Legitimate and surfaced —
 *                           the FAILED_TERMINAL path. Brief 26's fail-open rule intact.
 *   UNENCRYPTED_UNDECLARED  plaintext with no declaration. THE ORIGINAL DEFECT. Alertable,
 *                           because it means a client is shipping clear bytes while
 *                           believing (or claiming) otherwise.
 */

/** The envelope frame version byte written by lib/crypto/envelope.ts encryptChunk. */
const FRAME_VERSION = 1;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const COMMITMENT_RE = /^[0-9a-f]{64}$/i;

export type ObservedEncryptionState = 'ENCRYPTED' | 'UNENCRYPTED_DECLARED' | 'UNENCRYPTED_UNDECLARED';

export interface EncryptionObservation {
  state: ObservedEncryptionState;
  /** What the client claimed, kept only so a disagreement can be reported. Never stored
   *  as the state — the whole point is that the observation wins. */
  declared: string | null;
  /** True when the client declared one thing and the bytes say another. */
  mismatch: boolean;
  reason: string | null;
}

/**
 * Decide, from the bytes and the headers, what state this chunk is ACTUALLY in.
 * `bytes` is the raw request body; `commitment` and `declared` are the client's headers.
 */
export function observeChunkEncryption(
  bytes: Uint8Array,
  commitment: string,
  declared: string | null,
  reason: string | null,
): EncryptionObservation {
  const claim = declared && declared.trim() ? declared.trim() : null;
  const framed =
    bytes.byteLength >= 1 + IV_BYTES + GCM_TAG_BYTES &&
    bytes[0] === FRAME_VERSION &&
    COMMITMENT_RE.test(commitment);

  if (framed) {
    return {
      state: 'ENCRYPTED',
      declared: claim,
      // A chunk that looks encrypted while the client declared it plaintext is a
      // disagreement worth surfacing, even though the safe reading (encrypted) wins.
      mismatch: claim === 'UNENCRYPTED_DECLARED',
      reason,
    };
  }
  if (claim === 'UNENCRYPTED_DECLARED') {
    return { state: 'UNENCRYPTED_DECLARED', declared: claim, mismatch: false, reason };
  }
  // No frame, no declaration. This is the defect the brief was written for.
  return { state: 'UNENCRYPTED_UNDECLARED', declared: claim, mismatch: claim != null, reason };
}

/** Does this observation satisfy a REQUIRED policy? Only real conformance does — a
 *  declaration is honest, but honesty is not encryption. */
export function satisfiesRequiredPolicy(observation: EncryptionObservation): boolean {
  return observation.state === 'ENCRYPTED';
}

/**
 * Is rejection ARMED? Deliberately separate from the account's policy.
 *
 * The policy column defaults to REQUIRED (§E) because that is the intended end state, but
 * enforcing it today would stop evidence upload for every existing account — on the day
 * this shipped, zero production accounts had a public key, so nothing could conform. So
 * the policy ships armed and the ENFORCEMENT ships dark, behind this var. Arming it is
 * Brief 47's acceptance, and until that is green no document may state that capture is
 * encrypted.
 *
 * Default OFF, and it must be read as a string exactly like every other var here: an
 * unset var is off, never "probably on".
 */
export function encryptionEnforced(env: { ENCRYPTION_ENFORCED?: string }): boolean {
  return env.ENCRYPTION_ENFORCED === 'true';
}
