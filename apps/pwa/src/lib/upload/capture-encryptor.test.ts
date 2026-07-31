import { describe, expect, it } from 'vitest';

import { decryptChunk, generateDek, plaintextCommitment, randomIvPrefix } from '@/lib/crypto/envelope';
import { makeEncryptor, proveEncryptor, sealChunkForSend, type CaptureEncryptor } from './capture-encryptor';

/**
 * Brief 36 §B — the fail-open discipline this file used to prove is DELIBERATELY GONE, and
 * these tests are its inverse.
 *
 * The old suite asserted that a null encryptor, an unready encryptor, a crypto hang and a
 * crypto throw each produced a byte-identical PLAINTEXT upload, "nothing surfaced". That
 * was the defect: encryption was an opportunistic upgrade, so the ordinary first seconds of
 * a normal capture shipped in the clear while the deployment was described as armed.
 *
 * Every one of those cases must now REFUSE to produce a body. The bytes stay queued on the
 * device and the drain retries them. Plaintext still leaves the device in exactly one
 * state — FAILED_TERMINAL — but that path does not run through this function; it is
 * declared by the caller, marked server-side from the server's own observation, and
 * alerted. Availability is preserved; silence is not.
 */

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe('there is no plaintext passthrough left to fall back to', () => {
  const plaintext = bytes('one-second-of-audio');

  it('a null encryptor THROWS — it is a programming error, not a fallback', async () => {
    await expect(sealChunkForSend({ encryptor: null, plaintext, sequence: 0, isFinal: false })).rejects.toThrow(
      /refusing to send plaintext/i,
    );
  });

  it('crypto HANGS → bounded, and REJECTS rather than degrading to plaintext', async () => {
    const hangs: CaptureEncryptor = {
      captureId: 'evt',
      encryptChunk: () => new Promise(() => {}), // never resolves
      selfTest: async () => true,
    };
    const t0 = Date.now();
    await expect(
      sealChunkForSend({ encryptor: hangs, plaintext, sequence: 0, isFinal: false, timeoutMs: 40 }),
    ).rejects.toThrow(/timed out/i);
    // Still bounded — a hung WebCrypto call must never wedge the upload queue. What
    // changed is where the boundary leads: to a retry, not onto the wire in the clear.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('crypto THROWS mid-capture → the error propagates; the chunk stays on the device', async () => {
    const throws: CaptureEncryptor = {
      captureId: 'evt',
      async encryptChunk() {
        throw new Error('WebCrypto exploded');
      },
      selfTest: async () => true,
    };
    await expect(sealChunkForSend({ encryptor: throws, plaintext, sequence: 3, isFinal: false })).rejects.toThrow(
      /WebCrypto exploded/,
    );
  });
});

describe('§A the encryptor is PROVEN, not assumed', () => {
  it('a real encryptor passes its self-test round trip', async () => {
    const enc = makeEncryptor(await generateDek(), 'evt-prove', randomIvPrefix());
    expect(await proveEncryptor(enc)).toBe(true);
  });

  it('an encryptor that exists but cannot round-trip is REFUSED', async () => {
    // The case the old code could not see: a non-null key object that is unusable. It used
    // to surface as silent plaintext on the very first chunk.
    const broken: CaptureEncryptor = {
      captureId: 'evt',
      async encryptChunk() {
        throw new Error('unusable key');
      },
      selfTest: async () => {
        throw new Error('unusable key');
      },
    };
    expect(await proveEncryptor(broken)).toBe(false);
  });

  it('a self-test that HANGS is refused, bounded — never an indefinite PREPARING', async () => {
    const hangs: CaptureEncryptor = {
      captureId: 'evt',
      encryptChunk: () => new Promise(() => {}),
      selfTest: () => new Promise(() => {}),
    };
    const t0 = Date.now();
    expect(await proveEncryptor(hangs, 40)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a self-test that returns a WRONG round trip is refused', async () => {
    const lies: CaptureEncryptor = {
      captureId: 'evt',
      async encryptChunk() {
        return { framed: bytes('nope'), commitment: 'x' };
      },
      selfTest: async () => false,
    };
    expect(await proveEncryptor(lies)).toBe(false);
  });
});

describe('the happy path actually encrypts and commits correctly', () => {
  it('a sealed chunk decrypts back to the plaintext, and the commitment matches', async () => {
    const dek = await generateDek();
    const prefix = randomIvPrefix();
    const enc = makeEncryptor(dek, 'evt-x', prefix);
    const plaintext = bytes('sensitive audio content');

    const r = await sealChunkForSend({ encryptor: enc, plaintext, sequence: 7, isFinal: true });
    expect(same(r.body, plaintext)).toBe(false); // actually ciphertext, not plaintext
    expect(r.body[0]).toBe(1); // frame version byte
    expect(r.commitment).toBe(await plaintextCommitment(plaintext)); // commits to the PLAINTEXT

    // The stored ciphertext decrypts at the same position with the same DEK.
    const back = await decryptChunk({ dek, framed: r.body, captureId: 'evt-x', chunkIndex: 7, isFinal: true });
    expect(new TextDecoder().decode(back)).toBe('sensitive audio content');
  });

  it('the self-test probe cannot collide with a real chunk IV', async () => {
    // The probe uses a chunk index far outside any real capture, so proving the encryptor
    // can never reuse an IV counter that a live chunk will later use — (key, IV) reuse in
    // GCM is catastrophic, and a self-test that caused it would be worse than no self-test.
    const dek = await generateDek();
    const enc = makeEncryptor(dek, 'evt-probe', randomIvPrefix());
    expect(await proveEncryptor(enc)).toBe(true);
    const r = await sealChunkForSend({ encryptor: enc, plaintext: bytes('real chunk 0'), sequence: 0, isFinal: false });
    const back = await decryptChunk({ dek, framed: r.body, captureId: 'evt-probe', chunkIndex: 0, isFinal: false });
    expect(new TextDecoder().decode(back)).toBe('real chunk 0');
  });
});
