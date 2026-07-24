import { describe, expect, it } from 'vitest';

import { importPrivateKey, unwrapDek, wrapDek, generateDek, exportDekRaw } from './envelope';
import {
  createOrgKeyGrant,
  generateAccountKeypair,
  openOrgKeyGrant,
  restorePrivateKeyFromRecovery,
  wrapPrivateKeyForRecovery,
} from './key-custody';

/**
 * Brief 26 Phase 1 — key custody. Proves the individual-survivor recovery model
 * (decision A) and the per-seat org-key grant (§5) end-to-end against the envelope core.
 */

const raw = async (dek: import('./envelope').SealedEnvelope | CryptoKey): Promise<string> =>
  dek instanceof CryptoKey ? Array.from(await exportDekRaw(dek)).join(',') : '';

describe('account keypair generation', () => {
  it('produces distinct, usable SPKI/PKCS8 keys', async () => {
    const a = await generateAccountKeypair();
    const b = await generateAccountKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.publicKey.length).toBeGreaterThan(40);
    expect(a.privateKey.length).toBeGreaterThan(40);
    // The private key re-imports and works.
    await expect(importPrivateKey(a.privateKey)).resolves.toBeTruthy();
  });
});

describe('individual survivor recovery (decision A) — recovery code is the only way back', () => {
  it('wrap → restore with the RIGHT code returns the same private key', async () => {
    const kp = await generateAccountKeypair();
    const wrapped = await wrapPrivateKeyForRecovery(kp.privateKey, 'AB12-CD34-EF56');
    const restored = await restorePrivateKeyFromRecovery(wrapped, 'AB12-CD34-EF56');
    expect(restored).toBe(kp.privateKey);
  });

  it('a WRONG recovery code cannot restore (fails the tag)', async () => {
    const kp = await generateAccountKeypair();
    const wrapped = await wrapPrivateKeyForRecovery(kp.privateKey, 'AB12-CD34-EF56');
    await expect(restorePrivateKeyFromRecovery(wrapped, 'ZZ99-ZZ99-ZZ99')).rejects.toBeTruthy();
  });

  it('the wrap is salted — the same key + code wrapped twice differs (no fixed ciphertext)', async () => {
    const kp = await generateAccountKeypair();
    const w1 = await wrapPrivateKeyForRecovery(kp.privateKey, 'code-code-code');
    const w2 = await wrapPrivateKeyForRecovery(kp.privateKey, 'code-code-code');
    expect(w1.salt).not.toBe(w2.salt);
    expect(w1.box.ct).not.toBe(w2.box.ct);
  });
});

describe('per-seat org-key grant (§5)', () => {
  it('a seat opens its grant and can then operate the org key', async () => {
    const org = await generateAccountKeypair();
    const seat = await generateAccountKeypair();

    // The server stores this grant; it cannot open it.
    const grant = await createOrgKeyGrant(org.privateKey, seat.publicKey);
    // The seat recovers the org private key and unwraps an org-wrapped DEK.
    const recoveredOrgPriv = await openOrgKeyGrant(grant, seat.privateKey);
    const orgPrivKey = await importPrivateKey(recoveredOrgPriv);

    const dek = await generateDek();
    const orgWrap = await wrapDek(dek, await (await import('./envelope')).importPublicKey(org.publicKey));
    const viaSeat = await unwrapDek(orgWrap, orgPrivKey);
    expect(await raw(viaSeat)).toBe(await raw(dek));
  });

  it('a DIFFERENT seat cannot open the grant', async () => {
    const org = await generateAccountKeypair();
    const seat = await generateAccountKeypair();
    const intruder = await generateAccountKeypair();
    const grant = await createOrgKeyGrant(org.privateKey, seat.publicKey);
    await expect(openOrgKeyGrant(grant, intruder.privateKey)).rejects.toBeTruthy();
  });
});
