import { log } from '@/lib/log';
import type { ClosurePin, StoredPin } from '@/lib/crypto/pin';
import { getDB, promisifyRequest, transactionDone, STORE_USER_CONFIG } from './db';

/**
 * userConfig store access. Keyed single records. Holds the hashed closure pin
 * (Brief 9: 3-digit, full + prefix hashes, on-device only) and the legacy
 * 4-digit lock/duress pins.
 */

const PIN_KEY = 'pin';
const DURESS_PIN_KEY = 'duressPin';
const CLOSURE_PIN_KEY = 'closurePin';

async function putConfig<T>(key: string, value: T): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_USER_CONFIG, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_USER_CONFIG).put({ key, value }));
    await transactionDone(tx);
  } catch (error) {
    log.error('putConfig failed', error);
  }
}

async function getConfig<T>(key: string): Promise<T | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_USER_CONFIG, 'readonly');
    const record = await promisifyRequest<{ key: string; value: T } | undefined>(
      tx.objectStore(STORE_USER_CONFIG).get(key),
    );
    await transactionDone(tx);
    return record?.value ?? null;
  } catch (error) {
    log.error('getConfig failed', error);
    return null;
  }
}

export const setStoredPin = (value: StoredPin): Promise<void> => putConfig(PIN_KEY, value);
export const getStoredPin = (): Promise<StoredPin | null> => getConfig<StoredPin>(PIN_KEY);
export const setStoredDuressPin = (value: StoredPin): Promise<void> =>
  putConfig(DURESS_PIN_KEY, value);
export const getStoredDuressPin = (): Promise<StoredPin | null> => getConfig<StoredPin>(DURESS_PIN_KEY);

/** The 3-digit closure pin (full + prefix hashes), on-device only (Brief 9). */
export const setStoredClosurePin = (value: ClosurePin): Promise<void> =>
  putConfig(CLOSURE_PIN_KEY, value);
export const getStoredClosurePin = (): Promise<ClosurePin | null> =>
  getConfig<ClosurePin>(CLOSURE_PIN_KEY);

/** Brief 26 — the survivor's envelope keypair, device-custodied on-device (the private
 *  key never leaves except as the recovery-code-wrapped blob). Fail-open: putConfig
 *  swallows storage errors, so a custody hiccup never blocks onboarding. */
const ENVELOPE_KEY = 'envelopeKeypair';
export interface StoredEnvelopeKeypair {
  publicKey: string;
  privateKey: string;
}
export const setStoredEnvelopeKeypair = (value: StoredEnvelopeKeypair): Promise<void> =>
  putConfig(ENVELOPE_KEY, value);
export const getStoredEnvelopeKeypair = (): Promise<StoredEnvelopeKeypair | null> =>
  getConfig<StoredEnvelopeKeypair>(ENVELOPE_KEY);

/** Brief 27 — a resumable intake DRAFT, stored ONLY as a sealed blob (Sealed to the
 *  survivor's own key, never plaintext). A partial disclosure gets the same fail-closed
 *  protection as a filed one; a draft is never discarded and never stored in the clear. */
const INTAKE_DRAFT_KEY = 'intakeDraft';
export const setStoredIntakeDraft = (sealed: string): Promise<void> => putConfig(INTAKE_DRAFT_KEY, sealed);
export const getStoredIntakeDraft = (): Promise<string | null> => getConfig<string>(INTAKE_DRAFT_KEY);
export const clearStoredIntakeDraft = (): Promise<void> => putConfig(INTAKE_DRAFT_KEY, '');
