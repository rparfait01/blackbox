/**
 * Intake draft (Brief 27 §3) — partial intake state, saved so a survivor who stops halfway
 * never loses her disclosure and never has to start over (which retraumatizes). It obeys
 * the SAME fail-closed rule as a filed case file:
 *
 *   A draft is sealed to the survivor's own key, or it is not persisted at all. There is
 *   no plaintext draft — not while the flag is off, not as a fallback.
 *
 * When secure storage is unavailable (flag off / no key), saveDraft is a no-op: the draft
 * stays in memory for the session only. Nothing partial ever lands unencrypted.
 */
import { envelopeEncryptionEnabled } from '@/lib/env';
import { importPrivateKey, importPublicKey, openWithPrivateKey, sealToPublicKey, type SealedEnvelope } from '@/lib/crypto/envelope';
import {
  clearStoredIntakeDraft,
  getStoredEnvelopeKeypair,
  getStoredIntakeDraft,
  setStoredIntakeDraft,
} from '@/lib/storage/user-config';
import type { CaseFileRecord } from './case-file';

/** A draft is a partial record plus the step the survivor had reached. */
export type IntakeDraft = Partial<CaseFileRecord> & { step?: string; savedAt?: number };

/** Seal + persist a draft. Returns true only if it was actually sealed and stored; false
 *  (a no-op) when secure storage is unavailable — never a plaintext write. */
export async function saveDraft(draft: IntakeDraft): Promise<boolean> {
  if (!envelopeEncryptionEnabled) {
    return false; // fail-closed: no secure storage → in-memory only, nothing persisted
  }
  const kp = await getStoredEnvelopeKeypair();
  if (!kp?.publicKey) {
    return false;
  }
  try {
    const pub = await importPublicKey(kp.publicKey);
    const bytes = new TextEncoder().encode(JSON.stringify({ ...draft, savedAt: Date.now() }));
    const sealed: SealedEnvelope = await sealToPublicKey(bytes, pub);
    await setStoredIntakeDraft(JSON.stringify(sealed));
    return true;
  } catch {
    return false; // seal failed → nothing persisted (never a plaintext fallback)
  }
}

/** Load + open a saved draft with the survivor's own key. null when none/unopenable. */
export async function loadDraft(): Promise<IntakeDraft | null> {
  const kp = await getStoredEnvelopeKeypair();
  if (!kp?.privateKey) {
    return null;
  }
  const sealedStr = await getStoredIntakeDraft();
  if (!sealedStr) {
    return null;
  }
  try {
    const priv = await importPrivateKey(kp.privateKey);
    const bytes = await openWithPrivateKey(JSON.parse(sealedStr) as SealedEnvelope, priv);
    return JSON.parse(new TextDecoder().decode(bytes)) as IntakeDraft;
  } catch {
    return null;
  }
}

/** Discard a draft (after filing, or on the survivor's explicit request). */
export async function clearDraft(): Promise<void> {
  await clearStoredIntakeDraft();
}
