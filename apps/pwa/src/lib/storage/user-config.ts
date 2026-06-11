import { log } from '@/lib/log';
import type { StoredPin } from '@/lib/crypto/pin';
import { getDB, promisifyRequest, transactionDone, STORE_USER_CONFIG } from './db';

/**
 * userConfig store access (W6). Keyed single records. Currently holds the hashed
 * closure pin and duress pin; W9 will add the rest of the (disguised) settings.
 */

const PIN_KEY = 'pin';
const DURESS_PIN_KEY = 'duressPin';

interface ConfigRecord {
  key: string;
  value: StoredPin;
}

async function putConfig(key: string, value: StoredPin): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_USER_CONFIG, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_USER_CONFIG).put({ key, value }));
    await transactionDone(tx);
  } catch (error) {
    log.error('putConfig failed', error);
  }
}

async function getConfig(key: string): Promise<StoredPin | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_USER_CONFIG, 'readonly');
    const record = await promisifyRequest<ConfigRecord | undefined>(
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
export const getStoredPin = (): Promise<StoredPin | null> => getConfig(PIN_KEY);
export const setStoredDuressPin = (value: StoredPin): Promise<void> =>
  putConfig(DURESS_PIN_KEY, value);
export const getStoredDuressPin = (): Promise<StoredPin | null> => getConfig(DURESS_PIN_KEY);
