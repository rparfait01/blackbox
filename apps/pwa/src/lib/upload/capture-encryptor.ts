/**
 * Capture encryptor (Brief 26 → rewritten by Brief 36 §A/§B) — the ONLY place capture
 * bytes are encrypted.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT IS GONE:
 *
 *   "FAIL-OPEN IS THE DEFAULT PATH, NOT A CATCH HANDLER. The send path's body is ALWAYS
 *    the plaintext bytes to begin with."
 *
 * That made encryption an opportunistic upgrade applied when convenient, and every way it
 * could not be applied — flag off, keys missing, encryptor not ready yet, crypto threw,
 * crypto hung — returned the plaintext SILENTLY. Combined with an encryptor prepared
 * asynchronously after event open, the ordinary first seconds of a normal capture uploaded
 * in the clear while the deployment was described as encryption-armed.
 *
 * Encryption is now a PRECONDITION of transmission, not a best-effort enhancement:
 *
 *   - There is no plaintext passthrough here. A null encryptor is a PROGRAMMING ERROR and
 *     throws; it is not a fallback. The caller decides what may be sent by reading the
 *     capture's encryption state (lib/upload/encryption-state.ts), and this function is
 *     only ever reached once that state said ENCRYPTED.
 *   - A timeout or a throw no longer degrades to plaintext. It throws, the item stays
 *     queued on the device, and the drain retries it. Bytes are never quietly downgraded.
 *
 * Plaintext still LEAVES the device in exactly one state — FAILED_TERMINAL — and that path
 * does not come through here. It is declared: marked at the server from the server's own
 * observation, surfaced to the survivor, and alerted to the operator. Brief 26's rule that
 * availability outranks confidentiality is intact; what is gone is doing it quietly.
 */
import { decryptChunk, encryptChunk, plaintextCommitment } from '@/lib/crypto/envelope';

/** Hard bound on any per-chunk encryption attempt. Well above real AES-GCM cost for a ~1s
 *  chunk (sub-millisecond). A breach of it now means "retry later", never "send in clear". */
export const ENCRYPT_TIMEOUT_MS = 250;

/** A prepared per-capture encryptor. One DEK for the whole capture; chunks differ only by
 *  the counter IV (sequence) and the position-binding AAD. */
export interface CaptureEncryptor {
  captureId: string;
  encryptChunk(sequence: number, plaintext: Uint8Array, isFinal: boolean): Promise<{ framed: Uint8Array; commitment: string }>;
  /** Prove the encryptor actually round-trips (§A). See proveEncryptor. */
  selfTest(): Promise<boolean>;
}

export interface SealResult {
  /** The ciphertext to upload. */
  body: Uint8Array;
  /** The signed-into-chain PLAINTEXT commitment, computed before encryption. */
  commitment: string;
  isFinal: boolean;
}

/** Reject if the promise has not settled within ms. Rejects rather than resolving null:
 *  a hang must surface as a retryable failure, never as a silent downgrade. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`encryption timed out after ${ms}ms`));
      }
    }, ms);
    void p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  });
}

/**
 * Seal one chunk for transmission. THROWS if there is no encryptor, if encryption times
 * out, or if the crypto rejects — every one of which leaves the chunk queued on the device
 * rather than on the wire in the clear.
 */
export async function sealChunkForSend(opts: {
  encryptor: CaptureEncryptor | null;
  plaintext: Uint8Array;
  sequence: number;
  isFinal: boolean;
  timeoutMs?: number;
}): Promise<SealResult> {
  const enc = opts.encryptor;
  if (!enc) {
    // Deliberately fatal. Reaching here without an encryptor means the caller ignored the
    // capture's encryption state, and the old behaviour — return the plaintext — is the
    // exact defect this brief exists to remove.
    throw new Error('sealChunkForSend called with no encryptor — refusing to send plaintext');
  }
  const sealed = await withTimeout(
    enc.encryptChunk(opts.sequence, opts.plaintext, opts.isFinal),
    opts.timeoutMs ?? ENCRYPT_TIMEOUT_MS,
  );
  return { body: sealed.framed, commitment: sealed.commitment, isFinal: opts.isFinal };
}

/** Build a CaptureEncryptor from a per-capture DEK. Pure; the caller owns key setup. */
export function makeEncryptor(dek: CryptoKey, captureId: string, ivPrefix: Uint8Array): CaptureEncryptor {
  return {
    captureId,
    async encryptChunk(sequence, plaintext, isFinal) {
      // The commitment is of the PLAINTEXT, computed before encryption (admissibility).
      const commitment = await plaintextCommitment(plaintext);
      const framed = await encryptChunk({ dek, plaintext, captureId, chunkIndex: sequence, isFinal, ivPrefix });
      return { framed, commitment };
    },
    async selfTest() {
      // A REAL round trip on a probe: encrypt, then decrypt with the same DEK at the same
      // claimed position and compare the bytes back. A chunk index far outside any real
      // capture is used so the probe can never collide with a live chunk's IV counter.
      const probe = crypto.getRandomValues(new Uint8Array(32));
      const index = 0xffff_fffe;
      const framed = await encryptChunk({ dek, plaintext: probe, captureId, chunkIndex: index, isFinal: false, ivPrefix });
      const back = await decryptChunk({ dek, framed, captureId, chunkIndex: index, isFinal: false });
      return back.length === probe.length && back.every((b, i) => b === probe[i]);
    },
  };
}

/**
 * §A — "prove the encryptor before declaring READY; a self-test round trip, not merely a
 * non-null object." A key object can exist and still be unusable: a non-extractable or
 * wrong-usage key, a WebCrypto implementation that rejects the AAD shape, a DEK that was
 * generated but never actually usable for encrypt. Every one of those used to surface as
 * silent plaintext on the first chunk. Bounded, and false on any failure.
 */
export async function proveEncryptor(encryptor: CaptureEncryptor, timeoutMs = ENCRYPT_TIMEOUT_MS * 4): Promise<boolean> {
  try {
    return await withTimeout(encryptor.selfTest(), timeoutMs);
  } catch {
    return false;
  }
}

export interface WrappedKeyUpload {
  recipientType: 'survivor' | 'org';
  recipientRef: string | null;
  keyGeneration: number;
  algId: string;
  wrappedDek: string; // JSON of the sealed envelope
}

/** Serialize a wrapped DEK for upload. */
export function serializeWrap(env: { alg: string; epk: string; iv: string; ct: string }): string {
  return JSON.stringify(env);
}
