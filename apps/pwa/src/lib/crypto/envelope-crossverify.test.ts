import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as browser from './envelope';
// The Node port the deploy canary uses. Imported directly — no build step between the two
// implementations, because a build step is one more place for them to disagree.
import * as node from '../../../../../scripts/canary-envelope.mjs';

/**
 * Brief 36 §F — THE CROSS-VERIFICATION. This file is the deliverable, not the port.
 *
 * The canary has to encrypt for real: an exemption would make the deploy gate stop proving
 * anything about the path that actually carries evidence. But that means a SECOND
 * implementation of the envelope format, and two implementations of one format drift. A
 * drifted canary is worse than no canary — it would go green every deploy while producing
 * bytes no survivor's client could ever open.
 *
 * So drift is made impossible to ship rather than unlikely: shared vectors, both
 * implementations, byte-identical output, asserted here in CI. Change either side in a way
 * that alters the wire format and this goes red before the deploy does.
 *
 * The vectors pin the DETERMINISTIC half (chunk encryption: fixed DEK, fixed IV prefix →
 * fixed bytes). The ECIES wrap is necessarily non-deterministic — fresh ephemeral key and
 * IV per call — so it is verified the only way that means anything: INTEROP, each side
 * opening what the other sealed.
 */

interface Vector {
  captureId: string;
  chunkIndex: number;
  isFinal: boolean;
  dekRawB64: string;
  ivPrefixB64: string;
  plaintextB64: string;
  expectedFramedB64: string;
  expectedCommitment: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../../scripts/envelope-vectors.json', import.meta.url), 'utf8'),
) as { alg: string; vectors: Vector[] };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

describe('§F the two implementations agree on the wire format, byte for byte', () => {
  it('the vectors are not vacuous', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(4);
    expect(fixture.alg).toBe(browser.ENVELOPE_ALG);
    expect(fixture.alg).toBe(node.ENVELOPE_ALG);
  });

  it.each(fixture.vectors.map((v, i) => [i, v] as const))(
    'vector %i — both implementations reproduce the exact framed bytes',
    async (_i, v) => {
      const dekRaw = unb64(v.dekRawB64);
      const ivPrefix = unb64(v.ivPrefixB64);
      const plaintext = unb64(v.plaintextB64);
      const args = { plaintext, captureId: v.captureId, chunkIndex: v.chunkIndex, isFinal: v.isFinal, ivPrefix };

      const fromBrowser = await browser.encryptChunk({ dek: await browser.importDekRaw(dekRaw), ...args });
      const fromNode = await node.encryptChunk({ dek: await node.importDekRaw(dekRaw), ...args });

      // Each against the committed vector…
      expect(b64(fromBrowser)).toBe(v.expectedFramedB64);
      expect(b64(fromNode)).toBe(v.expectedFramedB64);
      // …and against each other, so a vector regenerated from a drifted impl still fails.
      expect(b64(fromNode)).toBe(b64(fromBrowser));

      // The commitment is of the PLAINTEXT and must match across both too — it is what a
      // later decryption is verified against, so a disagreement here breaks admissibility.
      expect(await browser.plaintextCommitment(plaintext)).toBe(v.expectedCommitment);
      expect(await node.plaintextCommitment(plaintext)).toBe(v.expectedCommitment);
    },
  );

  it.each(fixture.vectors.map((v, i) => [i, v] as const))(
    'vector %i — each implementation decrypts what the OTHER encrypted',
    async (_i, v) => {
      const dekRaw = unb64(v.dekRawB64);
      const framed = unb64(v.expectedFramedB64);
      const at = { captureId: v.captureId, chunkIndex: v.chunkIndex, isFinal: v.isFinal };

      const viaBrowser = await browser.decryptChunk({ dek: await browser.importDekRaw(dekRaw), framed, ...at });
      const viaNode = await node.decryptChunk({ dek: await node.importDekRaw(dekRaw), framed, ...at });
      expect(b64(viaBrowser)).toBe(v.plaintextB64);
      expect(b64(viaNode)).toBe(v.plaintextB64);
    },
  );

  it('the AAD position binding is identical — a moved chunk fails on BOTH sides', async () => {
    // If one implementation bound position differently, this is where it would show: the
    // canary would happily encrypt at a position the survivor's client would refuse.
    const v = fixture.vectors[0]!;
    const dekRaw = unb64(v.dekRawB64);
    const framed = unb64(v.expectedFramedB64);
    const moved = { captureId: v.captureId, chunkIndex: v.chunkIndex + 1, isFinal: v.isFinal };
    await expect(browser.decryptChunk({ dek: await browser.importDekRaw(dekRaw), framed, ...moved })).rejects.toThrow();
    await expect(node.decryptChunk({ dek: await node.importDekRaw(dekRaw), framed, ...moved })).rejects.toThrow();
  });
});

describe('§F the port survives Node’s Buffer pooling trap', () => {
  it('a Node Buffer payload produces the SAME bytes as the equivalent Uint8Array', async () => {
    // The canary failed its own self-test on exactly this, and the deploy correctly
    // refused to publish. `Buffer.prototype.slice` is a deprecated alias of `subarray`, so
    // it returns a VIEW into Node's shared 8 KB allocation pool — `bytes.slice().buffer`,
    // which is correct in the browser, handed WebCrypto the whole pool. A Node program
    // naturally reaches for Buffer, so this is pinned rather than merely fixed.
    const v = fixture.vectors[0]!;
    const dekRaw = unb64(v.dekRawB64);
    const plain = unb64(v.plaintextB64);
    const args = { captureId: v.captureId, chunkIndex: v.chunkIndex, isFinal: v.isFinal, ivPrefix: unb64(v.ivPrefixB64) };

    const fromView = await node.encryptChunk({ dek: await node.importDekRaw(dekRaw), plaintext: plain, ...args });
    // The same bytes, handed over as a pooled Buffer instead.
    const asBuffer = Buffer.from(plain) as unknown as Uint8Array;
    const fromBuffer = await node.encryptChunk({ dek: await node.importDekRaw(dekRaw), plaintext: asBuffer, ...args });

    expect(b64(fromBuffer)).toBe(b64(fromView));
    expect(b64(fromBuffer)).toBe(v.expectedFramedB64); // still agrees with the browser
    // And a pooled Buffer KEY must import to the same key as the plain view.
    const pooledKey = Buffer.from(dekRaw) as unknown as Uint8Array;
    const fromPooledKey = await node.encryptChunk({ dek: await node.importDekRaw(pooledKey), plaintext: plain, ...args });
    expect(b64(fromPooledKey)).toBe(v.expectedFramedB64);
  });
});

describe('§F the ECIES wrap interoperates in both directions', () => {
  it('Node seals a DEK to a browser-generated key; the browser opens it', async () => {
    const kp = await browser.generateEnvelopeKeypair();
    const pubB64 = await browser.exportPublicKey(kp.publicKey);
    const dek = await browser.generateDek();
    const raw = await browser.exportDekRaw(dek);

    const sealed = await node.sealToPublicKey(raw, await node.importPublicKey(pubB64));
    expect(sealed.alg).toBe(browser.ENVELOPE_ALG);
    const opened = await browser.openWithPrivateKey(sealed, kp.privateKey);
    expect(b64(opened)).toBe(b64(raw));
  });

  it('the browser seals to a Node-generated key; Node opens it', async () => {
    const kp = await node.generateEnvelopeKeypair();
    const pubB64 = await node.exportPublicKey(kp.publicKey);
    const raw = new Uint8Array(32).fill(9);

    const sealed = await browser.sealToPublicKey(raw, await browser.importPublicKey(pubB64));
    const opened = await node.openWithPrivateKey(sealed, kp.privateKey);
    expect(b64(opened)).toBe(b64(raw));
  });

  it('a wrong key cannot open either side’s envelope', async () => {
    const kp = await node.generateEnvelopeKeypair();
    const wrong = await browser.generateEnvelopeKeypair();
    const sealed = await node.sealToPublicKey(new Uint8Array(32).fill(1), kp.publicKey);
    await expect(browser.openWithPrivateKey(sealed, wrong.privateKey)).rejects.toThrow();
  });
});
