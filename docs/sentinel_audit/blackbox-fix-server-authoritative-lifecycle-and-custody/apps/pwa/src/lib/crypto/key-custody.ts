/**
 * Key custody (Brief 26, Phase 1) — generating and safeguarding the account/org keypairs
 * the envelope wraps to. Pure key-management on top of the envelope core; no capture-path
 * or account-flow wiring here (that arrives with the flag-on step). Dormant until armed.
 *
 * Custody model (decision A):
 *   - Individual survivor: the private key is safeguarded ONLY by the recovery code —
 *     wrap-at-rest under a code-derived key. Lose the device AND the code and it is gone.
 *     Stated plainly at setup.
 *   - Org-enrolled: additionally re-provisionable by the org (the org already holds an
 *     operating key), via the per-seat grant primitives below (§5).
 */
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportPrivateKey,
  exportPublicKey,
  generateEnvelopeKeypair,
  fromB64,
  openWithPrivateKey,
  sealToPublicKey,
  toB64,
  type SealedEnvelope,
  type SymBox,
} from './envelope';

/** OWASP-aligned PBKDF2 work factor for deriving an at-rest key from a recovery code. */
const KDF_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const AT_REST_KEY_BYTES = 32;

/** A generated account/org keypair. The private key stays client-custodied; only the
 *  public key is ever uploaded to the server. */
export interface AccountKeypair {
  publicKey: string; // SPKI base64
  privateKey: string; // PKCS8 base64 — never leaves the device in clear
}

export async function generateAccountKeypair(): Promise<AccountKeypair> {
  const kp = await generateEnvelopeKeypair();
  return {
    publicKey: await exportPublicKey(kp.publicKey),
    privateKey: await exportPrivateKey(kp.privateKey),
  };
}

/** Derive a 256-bit at-rest key from the recovery code (PBKDF2-SHA256). */
async function deriveRecoveryKey(recoveryCode: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(recoveryCode.trim()),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.slice().buffer, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    AT_REST_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** A private key sealed for recovery under a code-derived key. Opaque to the server if
 *  stored there for cross-device recovery — it holds this but cannot open it. */
export interface RecoveryWrappedKey {
  salt: string; // base64 PBKDF2 salt
  box: SymBox;
}

/** Wrap a private key at rest under the recovery code (decision A, individual survivor). */
export async function wrapPrivateKeyForRecovery(
  privateKeyB64: string,
  recoveryCode: string,
): Promise<RecoveryWrappedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const atRest = await deriveRecoveryKey(recoveryCode, salt);
  const box = await aesGcmEncrypt(atRest, fromB64(privateKeyB64));
  return { salt: toB64(salt), box };
}

/** Restore a private key from its recovery wrap. Throws under a wrong code (GCM tag). */
export async function restorePrivateKeyFromRecovery(
  wrapped: RecoveryWrappedKey,
  recoveryCode: string,
): Promise<string> {
  const atRest = await deriveRecoveryKey(recoveryCode, fromB64(wrapped.salt));
  return toB64(await aesGcmDecrypt(atRest, wrapped.box));
}

// --- Org-key delivery: per-seat grants (§5) ---

/** Seal the org private key to a seat's public key — one grant per active seat. The
 *  server stores N of these and can open none. */
export async function createOrgKeyGrant(orgPrivateKeyB64: string, seatPublicKeyB64: string): Promise<string> {
  const seatPub = await importPub(seatPublicKeyB64);
  const sealed = await sealToPublicKey(fromB64(orgPrivateKeyB64), seatPub);
  return JSON.stringify(sealed);
}

/** A seat opens its grant with its own private key, recovering the org private key. */
export async function openOrgKeyGrant(grantJson: string, seatPrivateKeyB64: string): Promise<string> {
  const sealed = JSON.parse(grantJson) as SealedEnvelope;
  const seatPriv = await importPriv(seatPrivateKeyB64);
  return toB64(await openWithPrivateKey(sealed, seatPriv));
}

// Local import helpers (the envelope core exports import for CryptoKey; here we bridge b64).
async function importPub(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', fromB64(b64).slice().buffer, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
async function importPriv(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', fromB64(b64).slice().buffer, { name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
}
