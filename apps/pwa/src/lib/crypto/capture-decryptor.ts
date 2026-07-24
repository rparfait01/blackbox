/**
 * Capture decryptor (Brief 26, Phase 1, state 6 — Review). The read side of the
 * envelope: an authorized party (the survivor with their own key, or a seat with the
 * org key) unwraps the per-capture DEK client-side and decrypts stored chunks to review.
 * The server is never involved in a decrypt and never holds a key that could do one.
 *
 * Every decrypt is verifiable against the signed pre-encryption plaintext commitment
 * (change #1) — verifyChunkCommitment — so a reviewer (or a court's expert) can confirm
 * the decrypted plaintext is exactly what the device captured.
 *
 * Fail-open interop: because the WRITE path falls back to plaintext on any error, an
 * encrypted capture may contain the occasional plaintext chunk. decryptStoredChunk
 * detects a non-envelope frame and returns those bytes as-is rather than failing the
 * whole review — availability of content outranks a clean, uniform stream.
 */
import {
  decryptChunk,
  importDekRaw,
  importPrivateKey,
  openWithPrivateKey,
  plaintextCommitment,
  type SealedEnvelope,
} from './envelope';

const FRAME_VERSION = 1;
const MIN_ENVELOPE_LEN = 1 + 12 + 16; // version + IV + GCM tag

/** Unwrap a capture's DEK from its stored wrapped form using an authorized private key
 *  (the survivor's own, or the org private key a seat recovered from its grant). */
export async function openCaptureDek(wrappedDekJson: string, privateKeyB64: string): Promise<CryptoKey> {
  const sealed = JSON.parse(wrappedDekJson) as SealedEnvelope;
  const priv = await importPrivateKey(privateKeyB64);
  const rawDek = await openWithPrivateKey(sealed, priv);
  return importDekRaw(rawDek);
}

export interface DecryptedChunk {
  plaintext: Uint8Array;
  /** false when this chunk was stored plaintext (a write-path fail-open fallback). */
  wasEncrypted: boolean;
}

/**
 * Decrypt one stored chunk. If the bytes are not an envelope frame (a plaintext
 * fallback), they are returned as-is with wasEncrypted=false. A frame that fails to
 * decrypt (wrong position, tamper, wrong key) throws — that is a real integrity signal a
 * reviewer must see, not something to silently paper over.
 */
export async function decryptStoredChunk(opts: {
  dek: CryptoKey;
  framed: Uint8Array;
  captureId: string;
  sequence: number;
  isFinal: boolean;
}): Promise<DecryptedChunk> {
  if (opts.framed.length < MIN_ENVELOPE_LEN || opts.framed[0] !== FRAME_VERSION) {
    // Not an envelope frame → a plaintext fallback chunk; hand back the content.
    return { plaintext: opts.framed, wasEncrypted: false };
  }
  const plaintext = await decryptChunk({
    dek: opts.dek,
    framed: opts.framed,
    captureId: opts.captureId,
    chunkIndex: opts.sequence,
    isFinal: opts.isFinal,
  });
  return { plaintext, wasEncrypted: true };
}

/** Verify a decrypted chunk against its signed pre-encryption commitment (admissibility).
 *  True means the decrypted plaintext is exactly what the device committed to at capture. */
export async function verifyChunkCommitment(plaintext: Uint8Array, expectedHash: string): Promise<boolean> {
  return (await plaintextCommitment(plaintext)) === expectedHash;
}
