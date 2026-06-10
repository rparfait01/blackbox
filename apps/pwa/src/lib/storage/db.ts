import { log } from '@/lib/log';

/**
 * IndexedDB plumbing. The database is named "stillpoint" (not "blackbox") so it
 * reads as a meditation app's storage in browser DevTools — facade consistency.
 */
export const DB_NAME = 'stillpoint';
export const DB_VERSION = 1;

export const STORE_SESSIONS = 'sessions';
export const STORE_RECORDINGS = 'recordings';
export const STORE_LOCATIONS = 'locations';

let dbPromise: Promise<IDBDatabase> | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB();
  }
  return dbPromise;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        sessions.createIndex('byStatus', 'status', { unique: false });
        sessions.createIndex('byStartTime', 'startTime', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const recordings = db.createObjectStore(STORE_RECORDINGS, {
          keyPath: ['sessionId', 'sequence'],
        });
        recordings.createIndex('bySession', 'sessionId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_LOCATIONS)) {
        const locations = db.createObjectStore(STORE_LOCATIONS, {
          keyPath: ['sessionId', 'timestamp'],
        });
        locations.createIndex('bySession', 'sessionId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      log.error('indexeddb open failed', request.error);
      reject(request.error);
    };
  });
}

/** Wrap an IDBRequest as a promise. */
export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolve when a transaction commits (atomicity barrier). */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
