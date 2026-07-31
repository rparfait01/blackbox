import { describe, expect, it } from 'vitest';

import { generateDek, importPublicKey, randomIvPrefix, wrapDek } from './envelope';
import { generateAccountKeypair } from './key-custody';
import { makeEncryptor, serializeWrap } from '@/lib/upload/capture-encryptor';
import { decryptStoredChunk, openCaptureDek, verifyChunkCommitment } from './capture-decryptor';

/**
 * Brief 26 state 6 (Review) — closing the "can encrypt but not decrypt" gap. This drives
 * the FULL round-trip exactly as production would: encrypt chunks with the capture
 * encryptor, wrap the DEK to the survivor, store it — then unwrap and decrypt and verify
 * the commitment, as the survivor's review client does. Nothing here uses a private key
 * the server ever holds.
 */

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('survivor review round-trip: encrypt → wrap → store → unwrap → decrypt → verify', () => {
  it('decrypts every chunk back to plaintext and verifies each commitment', async () => {
    const survivor = await generateAccountKeypair();
    const captureId = 'evt-review-1';

    // WRITE side (as the client does at capture): one DEK, wrap to survivor, encrypt chunks.
    const dek = await generateDek();
    const enc = makeEncryptor(dek, captureId, randomIvPrefix());
    const chunks = ['chunk-zero', 'chunk-one', 'the-final-chunk'];
    const stored: Array<{ framed: Uint8Array; commitment: string }> = [];
    for (let i = 0; i < chunks.length; i += 1) {
      stored.push(await enc.encryptChunk(i, bytes(chunks[i]!), i === chunks.length - 1));
    }
    // The stored wrapped DEK (server holds this JSON — opaque).
    const wrappedDekJson = serializeWrap(await wrapDek(dek, await importPub(survivor.publicKey)));

    // READ side (the survivor's review client): unwrap the DEK with their own key.
    const reviewDek = await openCaptureDek(wrappedDekJson, survivor.privateKey);
    for (let i = 0; i < stored.length; i += 1) {
      const out = await decryptStoredChunk({
        dek: reviewDek,
        framed: stored[i]!.framed,
        captureId,
        sequence: i,
        isFinal: i === stored.length - 1,
      });
      expect(out.wasEncrypted).toBe(true);
      expect(text(out.plaintext)).toBe(chunks[i]);
      // Admissibility: the decrypted plaintext matches the capture-time commitment.
      expect(await verifyChunkCommitment(out.plaintext, stored[i]!.commitment)).toBe(true);
    }
  });

  it('a WRONG key cannot unwrap the DEK', async () => {
    const survivor = await generateAccountKeypair();
    const intruder = await generateAccountKeypair();
    const dek = await generateDek();
    const wrappedDekJson = serializeWrap(await wrapDek(dek, await importPub(survivor.publicKey)));
    await expect(openCaptureDek(wrappedDekJson, intruder.privateKey)).rejects.toBeTruthy();
  });
});

describe('fail-open interop — a plaintext fallback chunk is returned, not an error', () => {
  it('a non-envelope frame decrypts as wasEncrypted=false with the bytes intact', async () => {
    const dek = await generateDek();
    const plaintextFallback = bytes('a chunk that was uploaded plaintext by fail-open');
    const out = await decryptStoredChunk({ dek, framed: plaintextFallback, captureId: 'e', sequence: 4, isFinal: false });
    expect(out.wasEncrypted).toBe(false);
    expect(text(out.plaintext)).toBe('a chunk that was uploaded plaintext by fail-open');
  });
});

describe('integrity signal — a tampered/misplaced envelope chunk throws (not silent)', () => {
  it('a flipped ciphertext byte fails the review decrypt', async () => {
    const dek = await generateDek();
    const enc = makeEncryptor(dek, 'evt', randomIvPrefix());
    const { framed } = await enc.encryptChunk(0, bytes('intact'), false);
    framed[framed.length - 1] ^= 0x01;
    await expect(decryptStoredChunk({ dek, framed, captureId: 'evt', sequence: 0, isFinal: false })).rejects.toBeTruthy();
  });
});

// Bridge b64 → CryptoKey for the public key (the decryptor imports private keys itself).
async function importPub(b64: string): Promise<CryptoKey> {
  return importPublicKey(b64);
}
