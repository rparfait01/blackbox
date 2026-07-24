/**
 * Zero-knowledge capture envelope — crypto core (Brief 26, Phase 1).
 *
 * WebCrypto ONLY (no libsodium/WASM — rejected at the crypto-review gate). Standard
 * ECIES: ephemeral ECDH P-256 → HKDF-SHA256 → AES-256-GCM key-wrap, with AES-256-GCM
 * for content. This module is PURE and touches nothing on the capture path; it is the
 * foundation the wiring (behind a flag, fail-open) is built on.
 *
 * It encodes the five changes locked at review:
 *   1. plaintextCommitment() — hash the PLAINTEXT (server never sees it) so the chain
 *      can commit to what the device captured, not just the ciphertext (admissibility).
 *   2. AAD binds captureId ‖ chunkIndex ‖ finalFlag — GCM authenticates content, not
 *      order, so position is bound in the AAD (anti-reorder / anti-splice). The chunk
 *      count is recorded separately by the caller (anti-truncation).
 *   3. Counter-based IV — 32-bit random per-capture prefix ‖ 64-bit chunk counter, so
 *      (key, IV) never collides on a single-writer stream (no birthday-bound risk).
 *   4. ENVELOPE_ALG identifier stored per wrapped key — a later X25519 / PQ-hybrid is a
 *      config change, not a rewrite.
 *   5. (disclosure lives in product copy, not here.)
 *
 * SECURITY MODEL: the server stores only ciphertext, wrapped keys (each itself
 * ciphertext under a public key), and hashes. A party holding all of that but no
 * PRIVATE key can recover no plaintext — proven in envelope.test.ts.
 */

/** Algorithm identifier stored alongside every wrapped key (change #4). */
export const ENVELOPE_ALG = 'p256-hkdf-sha256-aes256gcm/v1';

const AES_KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit GCM IV = 4-byte random prefix ‖ 8-byte counter
const IV_PREFIX_BYTES = 4;
const HKDF_INFO = new TextEncoder().encode('blackbox-zk-envelope/v1');
const FRAME_VERSION = 1;

// ---- base64 (matches lib/crypto/pin.ts) ----
export function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
function buf(bytes: Uint8Array): ArrayBuffer {
  // A fresh ArrayBuffer copy so callers can't retain a view into a shared buffer.
  return bytes.slice().buffer;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- keypairs (survivor / org / seat / ephemeral) ----

/** A fresh ECDH P-256 keypair. Extractable so the private half can be wrapped at rest
 *  (seat-key custody) or wrapped to a seat's pubkey (org-key delivery). */
export async function generateEnvelopeKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}
export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', buf(fromB64(b64)), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}
export async function importPrivateKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', buf(fromB64(b64)), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

// ---- per-capture data key (DEK) ----
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_BITS }, true, ['encrypt', 'decrypt']);
}
export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek));
}
export async function importDekRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// ---- content: per-chunk AEAD with counter IV + position-binding AAD ----

/** A random 32-bit IV prefix, generated ONCE per capture and reused across its chunks;
 *  the low 64 bits are the chunk counter, so no two chunks share an IV (change #3). */
export function randomIvPrefix(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_PREFIX_BYTES));
}

function makeIv(ivPrefix: Uint8Array, chunkIndex: number): Uint8Array {
  if (ivPrefix.length !== IV_PREFIX_BYTES) throw new Error('bad iv prefix');
  const iv = new Uint8Array(IV_BYTES);
  iv.set(ivPrefix, 0);
  // 64-bit big-endian counter in the trailing 8 bytes.
  const view = new DataView(iv.buffer, iv.byteOffset + IV_PREFIX_BYTES, 8);
  view.setBigUint64(0, BigInt(chunkIndex), false);
  return iv;
}

/** AAD binds the chunk's POSITION so a reordered/spliced/truncated chunk fails its tag
 *  (change #2): captureId ‖ 0x1f ‖ u32be(chunkIndex) ‖ finalFlag. */
function makeAad(captureId: string, chunkIndex: number, isFinal: boolean): Uint8Array {
  const id = new TextEncoder().encode(captureId);
  const tail = new Uint8Array(6);
  new DataView(tail.buffer).setUint32(0, chunkIndex >>> 0, false);
  tail[4] = 0x1f; // separator
  tail[5] = isFinal ? 1 : 0;
  return concat(id, tail);
}

/** Encrypt one chunk → framed bytes `[version ‖ iv(12) ‖ ciphertext+tag]`. The IV is
 *  stored in the frame (not secret); the AAD is NOT stored — it is reconstructed from
 *  the trusted position at decrypt, so a moved chunk cannot verify. */
export async function encryptChunk(opts: {
  dek: CryptoKey;
  plaintext: Uint8Array;
  captureId: string;
  chunkIndex: number;
  isFinal: boolean;
  ivPrefix: Uint8Array;
}): Promise<Uint8Array> {
  const iv = makeIv(opts.ivPrefix, opts.chunkIndex);
  const aad = makeAad(opts.captureId, opts.chunkIndex, opts.isFinal);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
      opts.dek,
      buf(opts.plaintext),
    ),
  );
  return concat(new Uint8Array([FRAME_VERSION]), iv, ct);
}

/** Decrypt one framed chunk. captureId/chunkIndex/isFinal come from the TRUSTED request
 *  position; if the frame was encrypted at a different position its AAD won't match and
 *  this throws — reorder, splice, and mislabelled-final are all caught here. */
export async function decryptChunk(opts: {
  dek: CryptoKey;
  framed: Uint8Array;
  captureId: string;
  chunkIndex: number;
  isFinal: boolean;
}): Promise<Uint8Array> {
  if (opts.framed.length < 1 + IV_BYTES + 16 || opts.framed[0] !== FRAME_VERSION) {
    throw new Error('bad chunk frame');
  }
  const iv = opts.framed.subarray(1, 1 + IV_BYTES);
  const ct = opts.framed.subarray(1 + IV_BYTES);
  const aad = makeAad(opts.captureId, opts.chunkIndex, opts.isFinal);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
    opts.dek,
    buf(ct),
  );
  return new Uint8Array(pt);
}

// ---- plaintext commitment (change #1, admissibility) ----

/** SHA-256 of the plaintext chunk, hex. Computed on-device BEFORE encryption; the
 *  server stores it and signs it into the integrity chain. This is what a later
 *  decryption is verified against — the fixed point custody hangs on. */
export async function plaintextCommitment(plaintext: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(plaintext)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// ---- ECIES seal/open (wrap a DEK, or the org private key, to a public key) ----

export interface SealedEnvelope {
  alg: string; // ENVELOPE_ALG — the wrap algorithm, stored per key (change #4)
  epk: string; // ephemeral public key (SPKI base64)
  iv: string; // AES-GCM IV (base64)
  ct: string; // wrapped bytes (base64)
}

async function deriveKek(
  ephemeralPriv: CryptoKey,
  otherPub: CryptoKey,
  salt: Uint8Array,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: otherPub }, ephemeralPriv, 256),
  );
  const hkdfKey = await crypto.subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(HKDF_INFO) },
    hkdfKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    usage,
  );
}

/** Seal bytes to a recipient's public key (ECIES). A fresh ephemeral keypair per call;
 *  the ephemeral public key is bound into the KDF salt. The server can store the result
 *  and never recover the plaintext without the recipient's private key. */
export async function sealToPublicKey(plaintext: Uint8Array, recipientPublicKey: CryptoKey): Promise<SealedEnvelope> {
  const ephemeral = await generateEnvelopeKeypair();
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey));
  const kek = await deriveKek(ephemeral.privateKey, recipientPublicKey, epkRaw, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, kek, buf(plaintext)));
  return { alg: ENVELOPE_ALG, epk: toB64(epkRaw), iv: toB64(iv), ct: toB64(ct) };
}

/** Open a sealed envelope with the recipient's private key. */
export async function openWithPrivateKey(env: SealedEnvelope, recipientPrivateKey: CryptoKey): Promise<Uint8Array> {
  if (env.alg !== ENVELOPE_ALG) throw new Error(`unsupported wrap alg: ${env.alg}`);
  const epkRaw = fromB64(env.epk);
  const ephemeralPub = await crypto.subtle.importKey('spki', buf(epkRaw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const kek = await deriveKek(recipientPrivateKey, ephemeralPub, epkRaw, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(env.iv)) }, kek, buf(fromB64(env.ct)));
  return new Uint8Array(pt);
}

/** Wrap a DEK to a recipient's public key (survivor + org at capture; recipient at
 *  release). Convenience over sealToPublicKey. */
export async function wrapDek(dek: CryptoKey, recipientPublicKey: CryptoKey): Promise<SealedEnvelope> {
  return sealToPublicKey(await exportDekRaw(dek), recipientPublicKey);
}
export async function unwrapDek(env: SealedEnvelope, recipientPrivateKey: CryptoKey): Promise<CryptoKey> {
  return importDekRaw(await openWithPrivateKey(env, recipientPrivateKey));
}

// ---- symmetric at-rest (seat private-key custody: PRF- or recovery-code-derived key) ----

export interface SymBox {
  iv: string;
  ct: string;
}

/** AES-256-GCM with a raw 32-byte key. Used to encrypt a seat's private key at rest
 *  under a key derived from the WebAuthn PRF output (where available) or, as the named
 *  fallback, the seat's recovery code (never silent — see the seat-custody layer). */
export async function aesGcmEncrypt(rawKey: Uint8Array, plaintext: Uint8Array): Promise<SymBox> {
  const key = await crypto.subtle.importKey('raw', buf(rawKey), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plaintext)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
export async function aesGcmDecrypt(rawKey: Uint8Array, box: SymBox): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(rawKey), { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(box.iv)) }, key, buf(fromB64(box.ct)));
  return new Uint8Array(pt);
}
