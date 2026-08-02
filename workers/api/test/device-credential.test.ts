import { describe, expect, it } from 'vitest';

import { deviceCanonical, verifyDeviceProof, DEVICE_SKEW_MS } from '../src/lib/device-credential';

/**
 * Brief 2 Fix A §0 + the ratified comparison rule.
 *
 * On the trigger, capture, cascade or closure path a new comparison FAILS OPEN by default and is
 * proven both ways before ship. Refuse-everyone on signup is an outage; on the alert path it is a
 * survivor who cannot call for help. So these tests care as much about what is ACCEPTED as about
 * what is refused — the accept cases are the safety cases.
 */
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiB64: btoa(String.fromCharCode(...spki)) };
}
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sign(priv: CryptoKey, msg: string) {
  return toHex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(msg)));
}

/** Minimal env: one user row, zero or one credential. */
const env = (opts: { armed: boolean; cred?: { id: string; publicKey: string; revokedAt?: number | null } }) =>
  ({
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (/deviceCredentialArmedAt FROM users/.test(sql)) {
              return { deviceCredentialArmedAt: opts.armed ? 1 : null };
            }
            if (/FROM device_credentials/.test(sql)) {
              return opts.cred ? { ...opts.cred, revokedAt: opts.cred.revokedAt ?? null } : null;
            }
            return null;
          },
        };
      },
    },
  }) as never;

const base = { userId: 'u1', eventId: 'e1', method: 'POST', path: '/v1/events/e1/chunks/0', bodyDigestHex: 'ab'.repeat(32) };

describe('§E1 an account without a credential is never blocked', () => {
  it('ACCEPTS an unsigned write while the account is unarmed', async () => {
    const v = await verifyDeviceProof(env({ armed: false }), { ...base, proof: {} });
    expect(v.decision).toBe('ACCEPTED_UNARMED');
  });

  it('ACCEPTS even an armed account that presents no proof — and records it', async () => {
    // Fail open. A client that lost its key mid-incident still gets its evidence stored.
    const v = await verifyDeviceProof(env({ armed: true }), { ...base, proof: {} });
    expect(v.decision).toBe('ACCEPTED_FAIL_OPEN');
    expect(v.detail).toMatch(/recorded/);
  });

  it('ACCEPTS a bad signature on an UNARMED account', async () => {
    const { spkiB64 } = await keypair();
    const v = await verifyDeviceProof(env({ armed: false, cred: { id: 'c1', publicKey: spkiB64 } }), {
      ...base,
      proof: { credentialId: 'c1', signature: 'de'.repeat(32), timestamp: Date.now() },
    });
    expect(v.decision).toBe('ACCEPTED_UNARMED');
  });
});

describe('§B a valid signature verifies, and only a wrong one on an armed account refuses', () => {
  it('PASSES: a correct signature is VERIFIED', async () => {
    const { kp, spkiB64 } = await keypair();
    const timestamp = Date.now();
    const sig = await sign(kp.privateKey, deviceCanonical({ ...base, timestamp }));
    const v = await verifyDeviceProof(env({ armed: true, cred: { id: 'c1', publicKey: spkiB64 } }), {
      ...base,
      proof: { credentialId: 'c1', signature: sig, timestamp },
      now: timestamp,
    });
    expect(v.decision).toBe('VERIFIED');
  });

  it('FAILS: a wrong signature on an ARMED account is REFUSED — the only refusal there is', async () => {
    const { kp, spkiB64 } = await keypair();
    const timestamp = Date.now();
    // Sign a DIFFERENT body than the one presented.
    const sig = await sign(kp.privateKey, deviceCanonical({ ...base, bodyDigestHex: 'cd'.repeat(32), timestamp }));
    const v = await verifyDeviceProof(env({ armed: true, cred: { id: 'c1', publicKey: spkiB64 } }), {
      ...base,
      proof: { credentialId: 'c1', signature: sig, timestamp },
      now: timestamp,
    });
    expect(v.decision).toBe('REFUSED');
  });

  it('FAILS: a revoked credential on an armed account is REFUSED', async () => {
    const { kp, spkiB64 } = await keypair();
    const timestamp = Date.now();
    const sig = await sign(kp.privateKey, deviceCanonical({ ...base, timestamp }));
    const v = await verifyDeviceProof(env({ armed: true, cred: { id: 'c1', publicKey: spkiB64, revokedAt: 1 } }), {
      ...base,
      proof: { credentialId: 'c1', signature: sig, timestamp },
      now: timestamp,
    });
    expect(v.decision).toBe('REFUSED');
  });
});

describe('§C a skewed clock never costs a survivor her evidence', () => {
  it('ACCEPTS a signature stamped far outside the window, and records why', async () => {
    // §E1/§0: a wrong device clock is not evidence of an attacker, and she cannot fix it
    // mid-incident. Refusing here would discard a real recording over a settings problem.
    const { kp, spkiB64 } = await keypair();
    const timestamp = Date.now();
    const sig = await sign(kp.privateKey, deviceCanonical({ ...base, timestamp }));
    const v = await verifyDeviceProof(env({ armed: true, cred: { id: 'c1', publicKey: spkiB64 } }), {
      ...base,
      proof: { credentialId: 'c1', signature: sig, timestamp },
      now: timestamp + DEVICE_SKEW_MS * 4,
    });
    expect(v.decision).toBe('ACCEPTED_FAIL_OPEN');
    expect(v.detail).toMatch(/window/);
  });

  it('the window is stated and is 5 minutes', () => {
    expect(DEVICE_SKEW_MS).toBe(5 * 60 * 1000);
  });
});

describe('§0 infrastructure failure is never a refusal', () => {
  it('ACCEPTS when the credential store throws', async () => {
    const broken = {
      DB: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as never;
    const v = await verifyDeviceProof(broken, { ...base, proof: { credentialId: 'c', signature: 'ab', timestamp: Date.now() } });
    expect(v.decision).toBe('ACCEPTED_FAIL_OPEN');
  });

  it('REFUSED is unreachable for any unarmed account, under every input', async () => {
    const { spkiB64 } = await keypair();
    for (const proof of [
      {},
      { credentialId: 'nope', signature: 'ab', timestamp: Date.now() },
      { credentialId: 'c1', signature: 'ff'.repeat(32), timestamp: 0 },
    ]) {
      const v = await verifyDeviceProof(env({ armed: false, cred: { id: 'c1', publicKey: spkiB64 } }), { ...base, proof });
      expect(v.decision, JSON.stringify(proof)).not.toBe('REFUSED');
    }
  });
});
