import { describe, expect, it } from 'vitest';

import { decryptChunk, generateDek, plaintextCommitment, randomIvPrefix } from '@/lib/crypto/envelope';
import {
  makeEncryptor,
  sealChunkForSend,
  type CaptureEncryptor,
} from './capture-encryptor';

/**
 * Brief 26 Phase 1 step 3 — FAIL-OPEN discipline. Every one of these proves the same
 * thing from a different failure: the survivor's capture bytes still land. Capture
 * availability outranks confidentiality, in every mode.
 */

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe('fail-open scenarios', () => {
  const plaintext = bytes('one-second-of-audio');

  it('flag OFF (no encryptor) → byte-identical plaintext upload, nothing surfaced', async () => {
    const r = await sealChunkForSend({ encryptor: null, plaintext, sequence: 0, isFinal: false });
    expect(r.encrypted).toBe(false);
    expect(r.commitment).toBeUndefined();
    expect(same(r.body, plaintext)).toBe(true); // byte-identical to today
  });

  it('flag ON but keys missing (encryptor not ready) → plaintext, no error', async () => {
    const notReady: CaptureEncryptor = {
      ready: false,
      captureId: 'evt',
      async encryptChunk() {
        throw new Error('should never be called when not ready');
      },
    };
    const r = await sealChunkForSend({ encryptor: notReady, plaintext, sequence: 0, isFinal: false });
    expect(r.encrypted).toBe(false);
    expect(same(r.body, plaintext)).toBe(true);
  });

  it('crypto HANGS → bounded, falls through to plaintext (never wedges the send)', async () => {
    const hangs: CaptureEncryptor = {
      ready: true,
      captureId: 'evt',
      encryptChunk: () => new Promise(() => {}), // never resolves
    };
    const t0 = Date.now();
    const r = await sealChunkForSend({ encryptor: hangs, plaintext, sequence: 0, isFinal: false, timeoutMs: 40 });
    expect(Date.now() - t0).toBeLessThan(500); // bounded, did not hang
    expect(r.encrypted).toBe(false);
    expect(same(r.body, plaintext)).toBe(true);
  });

  it('crypto THROWS mid-capture → plaintext, capture still lands', async () => {
    const throws: CaptureEncryptor = {
      ready: true,
      captureId: 'evt',
      async encryptChunk() {
        throw new Error('WebCrypto exploded');
      },
    };
    const r = await sealChunkForSend({ encryptor: throws, plaintext, sequence: 3, isFinal: false });
    expect(r.encrypted).toBe(false);
    expect(same(r.body, plaintext)).toBe(true);
  });

  it('mid-capture flag flip cannot change a chunk’s fate — seal reads only the encryptor', async () => {
    // A ready encryptor keeps encrypting no matter what a global flag does; a null one
    // keeps plaintext. sealChunkForSend never reads the flag, so a flip mid-capture can
    // neither corrupt nor mix schemes within one capture.
    const dek = await generateDek();
    const enc = makeEncryptor(dek, 'evt-flip', randomIvPrefix());
    const a = await sealChunkForSend({ encryptor: enc, plaintext, sequence: 0, isFinal: false });
    const b = await sealChunkForSend({ encryptor: enc, plaintext, sequence: 1, isFinal: true });
    expect(a.encrypted).toBe(true);
    expect(b.encrypted).toBe(true); // consistent across the capture regardless of any flag flip
  });
});

describe('the happy path actually encrypts and commits correctly', () => {
  it('a sealed chunk decrypts back to the plaintext, and the commitment matches', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const enc = makeEncryptor(dek, 'evt-x', prefix);
    const plaintext = bytes('sensitive audio content');

    const r = await sealChunkForSend({ encryptor: enc, plaintext, sequence: 7, isFinal: true });
    expect(r.encrypted).toBe(true);
    expect(same(r.body, plaintext)).toBe(false); // actually ciphertext, not plaintext
    expect(r.body[0]).toBe(1); // frame version byte
    expect(r.commitment).toBe(await plaintextCommitment(plaintext)); // commits to the PLAINTEXT

    // The stored ciphertext decrypts at the same position with the same DEK.
    const back = await decryptChunk({ dek, framed: r.body, captureId: 'evt-x', chunkIndex: 7, isFinal: true });
    expect(new TextDecoder().decode(back)).toBe('sensitive audio content');
  });
});
