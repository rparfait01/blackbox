/**
 * Survivor key provisioning (Brief 26, Phase 1 keygen) — wired into onboarding under the
 * SAME fail-open rule as the capture send path:
 *
 *   Provisioning must NEVER block reaching Armed, and NEVER break a trigger.
 *
 * It is fire-and-forget and bounded: if the flag is off it is a complete no-op; if key
 * generation, storage, or upload fails or hangs, the account simply has no envelope key
 * and every capture uploads plaintext — the survivor is still Armed, still triggers, just
 * without encryption. Encryption is a bonus layered on top; it is never a precondition.
 */
import { envelopeEncryptionEnabled } from '@/lib/env';
import { api } from '@/lib/api';
import { log } from '@/lib/log';
import { generateAccountKeypair, wrapPrivateKeyForRecovery } from '@/lib/crypto/key-custody';
import { getStoredEnvelopeKeypair, setStoredEnvelopeKeypair } from '@/lib/storage/user-config';

/** Upper bound on a provisioning run; a hang is abandoned, never awaited by any caller. */
export const PROVISION_TIMEOUT_MS = 8000;

/**
 * Provision the survivor's envelope key: device-custody the keypair, publish the public
 * key, and (when a recovery code is supplied) store the code-wrapped private key so a new
 * device can restore it (decision A). Fire-and-forget — returns void immediately; the
 * work runs in the background and can never delay onboarding or a trigger.
 */
export function provisionSurvivorKey(recoveryCode?: string): void {
  if (!envelopeEncryptionEnabled) {
    return; // flag off → no-op; onboarding is byte-identical
  }
  void withTimeout(runProvision(recoveryCode), PROVISION_TIMEOUT_MS).catch(() => {
    // Swallowed: provisioning never surfaces an error to the survivor.
  });
}

async function runProvision(recoveryCode?: string): Promise<void> {
  try {
    let kp = await getStoredEnvelopeKeypair();
    if (!kp) {
      kp = await generateAccountKeypair();
      // Device custody FIRST — the private key is safe locally before anything is uploaded.
      await setStoredEnvelopeKeypair(kp);
    }
    // Publish the PUBLIC key (idempotent). This is what lets captures be wrapped to the
    // survivor; without it, prepareEncryptor finds no key and stays plaintext.
    await api('/v1/me/pubkey', { body: { pubkey: kp.publicKey } });
    if (recoveryCode) {
      // Decision A: store the recovery-code-wrapped private key server-side (opaque).
      const wrapped = await wrapPrivateKeyForRecovery(kp.privateKey, recoveryCode);
      await api('/v1/me/recovery-key', { body: { wrapped: JSON.stringify(wrapped) } });
    }
  } catch (error) {
    log.error('survivor key provisioning failed; captures stay plaintext', error);
  }
}

/** Resolve to null if not settled within ms — a hang can never keep a caller waiting. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}
