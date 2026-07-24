/**
 * Capture encryptor (Brief 26, Phase 1, step 3) — the ONLY place capture bytes are
 * encrypted, wired into the upload send path with a single, load-bearing rule:
 *
 *   FAIL-OPEN IS THE DEFAULT PATH, NOT A CATCH HANDLER.
 *
 * The send path's body is ALWAYS the plaintext bytes to begin with. Encryption is an
 * opportunistic, BOUNDED upgrade that replaces the body only on full success within a
 * time bound. If the flag is off, the keys are missing, the encryptor isn't ready, the
 * crypto throws, or the crypto hangs → the plaintext upload proceeds unchanged. A
 * survivor's capture lands in every one of those cases. Capture availability outranks
 * confidentiality — always (see docs/brief26/THREAT_MODEL §0).
 *
 * There is NO unbounded await on crypto in the send path: encryptChunk is raced against
 * a timeout, so a hung Web Crypto call can never wedge the upload queue.
 */
import { encryptChunk, plaintextCommitment, type SealedEnvelope } from '@/lib/crypto/envelope';

/** Hard bound on any per-chunk encryption attempt. Well above real AES-GCM cost for a
 *  ~1s chunk (sub-millisecond); this exists only so a HANG falls through to plaintext. */
export const ENCRYPT_TIMEOUT_MS = 250;

/** A prepared per-capture encryptor. One DEK for the whole capture; chunks differ only
 *  by the counter IV (sequence) and the position-binding AAD. `ready` gates use. */
export interface CaptureEncryptor {
  ready: boolean;
  captureId: string;
  encryptChunk(sequence: number, plaintext: Uint8Array, isFinal: boolean): Promise<{ framed: Uint8Array; commitment: string }>;
}

export interface SealResult {
  /** What to actually upload — plaintext by default, ciphertext only on full success. */
  body: Uint8Array;
  /** The signed-into-chain plaintext commitment, present only when encrypted. */
  commitment?: string;
  isFinal: boolean;
  encrypted: boolean;
}

/** Resolve to null if the promise has not settled within ms — never rejects, so a hang
 *  can only degrade to plaintext, never throw into the send path. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
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
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null); // a throw is a fall-through to plaintext, not an error
        }
      },
    );
  });
}

/**
 * Decide what bytes to send for one chunk. Plaintext is the baseline; encryption is only
 * attempted when a READY encryptor exists, and even then a timeout or throw falls back to
 * plaintext. This function does NOT read the feature flag — the encryptor was decided once
 * at capture start — so flipping the flag mid-capture cannot change a chunk's fate or mix
 * schemes within a capture.
 */
export async function sealChunkForSend(opts: {
  encryptor: CaptureEncryptor | null;
  plaintext: Uint8Array;
  sequence: number;
  isFinal: boolean;
  timeoutMs?: number;
}): Promise<SealResult> {
  const plaintextResult: SealResult = { body: opts.plaintext, isFinal: opts.isFinal, encrypted: false };
  const enc = opts.encryptor;
  if (!enc || !enc.ready) {
    return plaintextResult; // flag off / keys missing / setup failed → plaintext, silently
  }
  const sealed = await withTimeout(
    enc.encryptChunk(opts.sequence, opts.plaintext, opts.isFinal),
    opts.timeoutMs ?? ENCRYPT_TIMEOUT_MS,
  );
  if (!sealed) {
    return plaintextResult; // hung or threw → plaintext, silently, capture still lands
  }
  return { body: sealed.framed, commitment: sealed.commitment, isFinal: opts.isFinal, encrypted: true };
}

/** Build a CaptureEncryptor from a per-capture DEK. Pure; the caller owns key setup. */
export function makeEncryptor(dek: CryptoKey, captureId: string, ivPrefix: Uint8Array): CaptureEncryptor {
  return {
    ready: true,
    captureId,
    async encryptChunk(sequence, plaintext, isFinal) {
      // The commitment is of the PLAINTEXT, computed before encryption (admissibility).
      const commitment = await plaintextCommitment(plaintext);
      const framed = await encryptChunk({ dek, plaintext, captureId, chunkIndex: sequence, isFinal, ivPrefix });
      return { framed, commitment };
    },
  };
}

export interface WrappedKeyUpload {
  recipientType: 'survivor' | 'org';
  recipientRef: string | null;
  keyGeneration: number;
  algId: string;
  wrappedDek: string; // JSON of the sealed envelope
}

/** Serialize a wrapped DEK for upload. */
export function serializeWrap(env: SealedEnvelope): string {
  return JSON.stringify(env);
}
