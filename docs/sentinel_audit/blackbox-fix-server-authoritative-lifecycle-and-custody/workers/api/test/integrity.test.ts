/**
 * Brief 15 §F tripwire — custody integrity signing + export verification.
 * A closure report / evidence package is Ed25519-signed with a server-held key;
 * a verifier checks it against the published public key. Tampering with any
 * signed byte must flip verification to false.
 */
import { describe, expect, it } from 'vitest';

import { sign, verify, verifyManifest } from '../src/lib/integrity';
import type { Env } from '../src/types';

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function makeKeypair(): Promise<{ signingKeyB64: string; publicKeyB64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { signingKeyB64: bytesToB64(pkcs8), publicKeyB64: bytesToB64(spki) };
}

describe('Ed25519 sign + verify', () => {
  it('verifies a genuine signature and rejects a tampered payload', async () => {
    const { signingKeyB64, publicKeyB64 } = await makeKeypair();
    const env = { INTEGRITY_SIGNING_KEY: signingKeyB64, INTEGRITY_PUBLIC_KEY: publicKeyB64 } as Env;

    const payload = JSON.stringify({ eventId: 'e1', head: 'abc123', files: 3 });
    const signature = await sign(env, payload);
    expect(signature).toBeTruthy();

    expect(await verify(payload, signature!, publicKeyB64)).toBe(true);
    // Flip one byte of the signed data → verification fails.
    expect(await verify(payload + ' ', signature!, publicKeyB64)).toBe(false);
    // A different (unrelated) key cannot validate it either.
    const other = await makeKeypair();
    expect(await verify(payload, signature!, other.publicKeyB64)).toBe(false);
  });

  it('returns false (never throws) on a malformed signature or key', async () => {
    expect(await verify('data', 'not-base64-!!', 'also-bad')).toBe(false);
  });
});

describe('verifyManifest — full export round-trip', () => {
  it('accepts an untampered manifest and rejects a tampered one', async () => {
    const { signingKeyB64, publicKeyB64 } = await makeKeypair();
    const env = { INTEGRITY_SIGNING_KEY: signingKeyB64, INTEGRITY_PUBLIC_KEY: publicKeyB64 } as Env;

    // Mirror exportPackage: sign JSON.stringify(unsigned-with-publicKey), then
    // attach the signature last.
    const unsigned = {
      version: 'blackbox-custody-1',
      eventId: 'e1',
      chain: { head: 'deadbeef', records: [{ seq: 0, chainHash: 'h0' }] },
      publicKey: publicKeyB64,
    };
    const signature = await sign(env, JSON.stringify(unsigned));
    const manifest = { ...unsigned, signature: signature! };

    expect(await verifyManifest(manifest)).toBe(true);

    // Tamper a signed field → fails.
    const tampered = { ...manifest, chain: { head: 'TAMPERED', records: [{ seq: 0, chainHash: 'h0' }] } };
    expect(await verifyManifest(tampered)).toBe(false);

    // Strip the signature → fails (no silent pass).
    const noSig: Record<string, unknown> = { ...manifest };
    delete noSig.signature;
    expect(await verifyManifest(noSig)).toBe(false);
  });
});
