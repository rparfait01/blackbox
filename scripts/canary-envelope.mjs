/**
 * Node port of the capture envelope (Brief 36 §F) — so the deploy canary traverses the REAL
 * encryption path rather than a look-alike.
 *
 * WHY A PORT AT ALL. The canary proves the alert path exists by completing a real
 * transaction against production. Once chunks must be encrypted, a canary that skipped
 * encryption would prove the one thing that no longer matters — an exemption would make the
 * gate stop testing the path that actually carries evidence. So the canary encrypts, with
 * its own keypair, exactly as a phone does.
 *
 * WHY A PORT IS DANGEROUS, AND WHAT MAKES IT SAFE. Two implementations of one crypto format
 * can drift, and a drifted canary is worse than no canary: it would go green while
 * producing bytes no survivor's client could ever decrypt. The port is therefore NOT the
 * deliverable. The cross-verification is — shared vectors in envelope-vectors.json, both
 * implementations, byte-identical output, asserted in CI by
 * apps/pwa/src/lib/crypto/envelope-crossverify.test.ts. If they can drift, it isn't done.
 *
 * Every constant below is duplicated from apps/pwa/src/lib/crypto/envelope.ts DELIBERATELY
 * rather than imported: that file is TypeScript built for the browser, and a build step
 * between the gate and the thing it checks is one more place for them to disagree. The
 * duplication is safe only because the vectors prove it.
 *
 * Uses WebCrypto (globalThis.crypto.subtle), the same API the browser uses, so the two
 * implementations differ in as little as possible.
 */

const subtle = globalThis.crypto.subtle;

export const ENVELOPE_ALG = 'p256-hkdf-sha256-aes256gcm/v1';

const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const IV_PREFIX_BYTES = 4;
const HKDF_INFO = new TextEncoder().encode('blackbox-zk-envelope/v1');
const FRAME_VERSION = 1;

export function toB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
export function fromB64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function buf(bytes) {
  return bytes.slice().buffer;
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- keys ----
export async function generateEnvelopeKeypair() {
  return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
export async function exportPublicKey(key) {
  return toB64(new Uint8Array(await subtle.exportKey('spki', key)));
}
export async function importPublicKey(b64) {
  return subtle.importKey('spki', buf(fromB64(b64)), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
export async function importPrivateKey(b64) {
  return subtle.importKey('pkcs8', buf(fromB64(b64)), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
export async function exportPrivateKey(key) {
  return toB64(new Uint8Array(await subtle.exportKey('pkcs8', key)));
}

// ---- per-capture data key ----
export async function generateDek() {
  return subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_BITS }, true, ['encrypt', 'decrypt']);
}
export async function importDekRaw(raw) {
  return subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
export async function exportDekRaw(dek) {
  return new Uint8Array(await subtle.exportKey('raw', dek));
}

export function randomIvPrefix() {
  return globalThis.crypto.getRandomValues(new Uint8Array(IV_PREFIX_BYTES));
}

/** 96-bit GCM IV = 4-byte per-capture random prefix ‖ 64-bit big-endian chunk counter. */
function makeIv(ivPrefix, chunkIndex) {
  if (ivPrefix.length !== IV_PREFIX_BYTES) throw new Error('bad iv prefix');
  const iv = new Uint8Array(IV_BYTES);
  iv.set(ivPrefix, 0);
  new DataView(iv.buffer, iv.byteOffset + IV_PREFIX_BYTES, 8).setBigUint64(0, BigInt(chunkIndex), false);
  return iv;
}

/** AAD binds POSITION so a reordered/spliced chunk fails its tag:
 *  captureId ‖ u32be(chunkIndex) ‖ 0x1f ‖ finalFlag. */
function makeAad(captureId, chunkIndex, isFinal) {
  const id = new TextEncoder().encode(captureId);
  const tail = new Uint8Array(6);
  new DataView(tail.buffer).setUint32(0, chunkIndex >>> 0, false);
  tail[4] = 0x1f;
  tail[5] = isFinal ? 1 : 0;
  return concat(id, tail);
}

/** Encrypt one chunk → `[version ‖ iv(12) ‖ ciphertext+tag]`. */
export async function encryptChunk({ dek, plaintext, captureId, chunkIndex, isFinal, ivPrefix }) {
  const iv = makeIv(ivPrefix, chunkIndex);
  const aad = makeAad(captureId, chunkIndex, isFinal);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, dek, buf(plaintext)),
  );
  return concat(new Uint8Array([FRAME_VERSION]), iv, ct);
}

export async function decryptChunk({ dek, framed, captureId, chunkIndex, isFinal }) {
  if (framed.length < 1 + IV_BYTES + 16 || framed[0] !== FRAME_VERSION) {
    throw new Error('bad chunk frame');
  }
  const iv = framed.subarray(1, 1 + IV_BYTES);
  const ct = framed.subarray(1 + IV_BYTES);
  const aad = makeAad(captureId, chunkIndex, isFinal);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, dek, buf(ct));
  return new Uint8Array(pt);
}

/** SHA-256 of the PLAINTEXT, hex — computed before encryption (admissibility). */
export async function plaintextCommitment(plaintext) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', buf(plaintext)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// ---- ECIES seal (wrap a DEK to a public key) ----
async function deriveKek(ephemeralPriv, otherPub, salt, usage) {
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: otherPub }, ephemeralPriv, 256));
  const hkdfKey = await subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(HKDF_INFO) },
    hkdfKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    usage,
  );
}

export async function sealToPublicKey(plaintext, recipientPublicKey) {
  const ephemeral = await generateEnvelopeKeypair();
  const epkRaw = new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey));
  const kek = await deriveKek(ephemeral.privateKey, recipientPublicKey, epkRaw, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, kek, buf(plaintext)));
  return { alg: ENVELOPE_ALG, epk: toB64(epkRaw), iv: toB64(iv), ct: toB64(ct) };
}

export async function openWithPrivateKey(env, recipientPrivateKey) {
  if (env.alg !== ENVELOPE_ALG) throw new Error(`unsupported wrap alg: ${env.alg}`);
  const epkRaw = fromB64(env.epk);
  const ephemeralPub = await subtle.importKey('spki', buf(epkRaw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const kek = await deriveKek(recipientPrivateKey, ephemeralPub, epkRaw, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(env.iv)) }, kek, buf(fromB64(env.ct)));
  return new Uint8Array(pt);
}

export async function wrapDek(dek, recipientPublicKey) {
  return sealToPublicKey(await exportDekRaw(dek), recipientPublicKey);
}
export async function unwrapDek(env, recipientPrivateKey) {
  return importDekRaw(await openWithPrivateKey(env, recipientPrivateKey));
}
