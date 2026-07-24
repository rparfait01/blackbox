import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_ALG,
  aesGcmDecrypt,
  aesGcmEncrypt,
  decryptChunk,
  encryptChunk,
  exportDekRaw,
  exportPrivateKey,
  exportPublicKey,
  generateDek,
  generateEnvelopeKeypair,
  importPrivateKey,
  importPublicKey,
  openWithPrivateKey,
  plaintextCommitment,
  randomIvPrefix,
  sealToPublicKey,
  unwrapDek,
  wrapDek,
} from './envelope';

/**
 * Brief 26 Phase 1 — the envelope crypto core. These prove the properties the whole
 * zero-knowledge claim rests on: the server (holding ciphertext + wrapped keys + public
 * keys, but no private key) can recover NOTHING; a reordered, spliced, or tampered chunk
 * fails to decrypt; and org-key rotation (full re-wrap) revokes a departed seat.
 */

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('keypairs round-trip through export/import', () => {
  it('public and private keys survive SPKI/PKCS8 base64', async () => {
    const kp = await generateEnvelopeKeypair();
    const pub = await importPublicKey(await exportPublicKey(kp.publicKey));
    const priv = await importPrivateKey(await exportPrivateKey(kp.privateKey));
    // Prove the re-imported pair still works end-to-end via a seal/open.
    const sealed = await sealToPublicKey(bytes('recovered'), pub);
    expect(text(await openWithPrivateKey(sealed, priv))).toBe('recovered');
  });
});

describe('DEK wrapping to survivor AND org (states 3–6)', () => {
  it('a DEK wrapped to two keys is recoverable by EITHER private key', async () => {
    const survivor = await generateEnvelopeKeypair();
    const org = await generateEnvelopeKeypair();
    const dek = await generateDek();
    const raw = await exportDekRaw(dek);

    const toSurvivor = await wrapDek(dek, survivor.publicKey);
    const toOrg = await wrapDek(dek, org.publicKey);

    const viaSurvivor = await unwrapDek(toSurvivor, survivor.privateKey);
    const viaOrg = await unwrapDek(toOrg, org.privateKey);
    expect(text(await exportDekRaw(viaSurvivor))).toBe(text(raw));
    expect(text(await exportDekRaw(viaOrg))).toBe(text(raw));
  });
});

describe('PROVE THE SERVER CANNOT DECRYPT', () => {
  it('holding the sealed envelope + both public keys but no private key recovers nothing', async () => {
    const survivor = await generateEnvelopeKeypair();
    const org = await generateEnvelopeKeypair();
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, org.publicKey);

    // The "server" holds: the wrapped DEK, the survivor pubkey, the org pubkey.
    // It has NO private key. An attacker with a freshly minted keypair cannot open it.
    const attacker = await generateEnvelopeKeypair();
    await expect(openWithPrivateKey(wrapped, attacker.privateKey)).rejects.toBeTruthy();
    // Even re-deriving from the public keys it holds gets it nowhere — publics can't open.
    await expect(unwrapDek(wrapped, survivor.privateKey)).rejects.toBeTruthy(); // wrong recipient
  });

  it('a wrapped key carries the algorithm identifier, and a foreign alg is refused', async () => {
    const org = await generateEnvelopeKeypair();
    const wrapped = await wrapDek(await generateDek(), org.publicKey);
    expect(wrapped.alg).toBe(ENVELOPE_ALG);
    await expect(openWithPrivateKey({ ...wrapped, alg: 'x25519-future/v9' }, org.privateKey)).rejects.toThrow(/unsupported/);
  });
});

describe('per-chunk content encryption (states 2, 4, 6)', () => {
  const captureId = 'evt-abc123';

  it('encrypt → decrypt round-trips at the same position', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek, plaintext: bytes('audio-chunk-5'), captureId, chunkIndex: 5, isFinal: false, ivPrefix: prefix });
    const out = await decryptChunk({ dek, framed, captureId, chunkIndex: 5, isFinal: false });
    expect(text(out)).toBe('audio-chunk-5');
  });

  it('REORDER is caught — a chunk decrypted at the wrong index fails (AAD binds position)', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek, plaintext: bytes('chunk-5'), captureId, chunkIndex: 5, isFinal: false, ivPrefix: prefix });
    await expect(decryptChunk({ dek, framed, captureId, chunkIndex: 3, isFinal: false })).rejects.toBeTruthy();
  });

  it('SPLICE across captures is caught — same index, different captureId fails', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek, plaintext: bytes('chunk-5'), captureId, chunkIndex: 5, isFinal: false, ivPrefix: prefix });
    await expect(decryptChunk({ dek, framed, captureId: 'evt-OTHER', chunkIndex: 5, isFinal: false })).rejects.toBeTruthy();
  });

  it('a mislabelled FINAL flag is caught — the terminal marker is authenticated', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek, plaintext: bytes('last'), captureId, chunkIndex: 9, isFinal: true, ivPrefix: prefix });
    await expect(decryptChunk({ dek, framed, captureId, chunkIndex: 9, isFinal: false })).rejects.toBeTruthy();
  });

  it('TAMPER is caught — a flipped ciphertext byte fails the GCM tag', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek, plaintext: bytes('intact'), captureId, chunkIndex: 1, isFinal: false, ivPrefix: prefix });
    framed[framed.length - 1] ^= 0x01;
    await expect(decryptChunk({ dek, framed, captureId, chunkIndex: 1, isFinal: false })).rejects.toBeTruthy();
  });

  it('a WRONG DEK cannot decrypt', async () => {
    const prefix = randomIvPrefix();
    const framed = await encryptChunk({ dek: await generateDek(), plaintext: bytes('x'), captureId, chunkIndex: 0, isFinal: false, ivPrefix: prefix });
    await expect(decryptChunk({ dek: await generateDek(), framed, captureId, chunkIndex: 0, isFinal: false })).rejects.toBeTruthy();
  });

  it('IV is counter-derived: same plaintext at different indices yields different ciphertext', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const a = await encryptChunk({ dek, plaintext: bytes('same'), captureId, chunkIndex: 0, isFinal: false, ivPrefix: prefix });
    const b = await encryptChunk({ dek, plaintext: bytes('same'), captureId, chunkIndex: 1, isFinal: false, ivPrefix: prefix });
    // Frames differ (different IV counter → different ciphertext), so no (key,IV) reuse.
    expect(text(a)).not.toBe(text(b));
    // The 8-byte counter region of the IV differs; the 4-byte prefix matches.
    expect(Array.from(a.subarray(1, 5))).toEqual(Array.from(b.subarray(1, 5))); // prefix equal
    expect(Array.from(a.subarray(5, 13))).not.toEqual(Array.from(b.subarray(5, 13))); // counter differs
  });
});

describe('plaintext commitment (admissibility, change #1)', () => {
  it('is deterministic and matches the known SHA-256 of empty', async () => {
    expect(await plaintextCommitment(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('differs when the plaintext differs', async () => {
    expect(await plaintextCommitment(bytes('a'))).not.toBe(await plaintextCommitment(bytes('b')));
  });
});

describe('org-key delivery: wrapping a PRIVATE key to a seat (per-seat grants, §5)', () => {
  it('the org private key wrapped to a seat pub is recovered by the seat priv, then usable', async () => {
    const org = await generateEnvelopeKeypair();
    const seat = await generateEnvelopeKeypair();
    const orgPrivBytes = fromRawPriv(await exportPrivateKey(org.privateKey));

    // Server stores this — a copy of the org private key sealed to THIS seat.
    const grant = await sealToPublicKey(orgPrivBytes, seat.publicKey);
    // The seat unwraps it and can then operate the org key (open an org-wrapped DEK).
    const recoveredOrgPriv = await importPrivateKey(toRawPriv(await openWithPrivateKey(grant, seat.privateKey)));
    const dek = await generateDek();
    const orgWrap = await wrapDek(dek, org.publicKey);
    const viaSeat = await unwrapDek(orgWrap, recoveredOrgPriv);
    expect(text(await exportDekRaw(viaSeat))).toBe(text(await exportDekRaw(dek)));
  });
});

describe('state 8: full re-wrap on org rotation revokes a departed seat', () => {
  it('after rotation the new org key opens the DEK; the OLD org key cannot open the re-wrap', async () => {
    const orgGen1 = await generateEnvelopeKeypair();
    const orgGen2 = await generateEnvelopeKeypair();
    const dek = await generateDek();

    // Captured under gen-1.
    const wrap1 = await wrapDek(dek, orgGen1.publicKey);
    // A remaining seat unwraps with gen-1 and RE-WRAPS to gen-2 (full re-wrap).
    const dekAgain = await unwrapDek(wrap1, orgGen1.privateKey);
    const wrap2 = await wrapDek(dekAgain, orgGen2.publicKey);

    // Remaining seats (gen-2) still open it.
    expect(text(await exportDekRaw(await unwrapDek(wrap2, orgGen2.privateKey)))).toBe(text(await exportDekRaw(dek)));
    // A departed seat that cached ONLY the gen-1 key cannot open the re-wrapped copy.
    await expect(unwrapDek(wrap2, orgGen1.privateKey)).rejects.toBeTruthy();
  });
});

describe('symmetric at-rest (seat-key custody under PRF / recovery-code key)', () => {
  it('round-trips under the right key and fails under the wrong one', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    const box = await aesGcmEncrypt(key, bytes('seat-private-key-material'));
    expect(text(await aesGcmDecrypt(key, box))).toBe('seat-private-key-material');
    await expect(aesGcmDecrypt(wrong, box)).rejects.toBeTruthy();
  });
});

// PKCS8 export/import returns base64; these helpers keep the org-key-grant test readable
// by moving raw bytes through the same base64 the wrapping uses.
function fromRawPriv(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function toRawPriv(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
