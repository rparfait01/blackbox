import { log } from '@/lib/log';
import type { Classification } from '@blackbox/classifier';
import {
  getDB,
  promisifyRequest,
  transactionDone,
  STORE_SESSIONS,
  STORE_RECORDINGS,
  STORE_LOCATIONS,
  STORE_TRANSCRIPTS,
  STORE_CLASSIFICATIONS,
  STORE_UPLOAD_QUEUE,
} from './db';
import type {
  LocationPoint,
  RecordingChunk,
  SessionRecord,
  SessionStatus,
  StoredClassification,
  TranscriptFragment,
  UploadQueueItem,
} from './types';

export type {
  ActivationSource,
  CaptureMode,
  LocationPoint,
  RecordingChunk,
  SessionRecord,
  SessionStatus,
  StoredClassification,
  TranscriptFragment,
  UploadKind,
  UploadQueueItem,
} from './types';

export {
  getStoredPin,
  setStoredPin,
  getStoredDuressPin,
  setStoredDuressPin,
} from './user-config';

/**
 * Append-only local store. Recording chunks and location points are written
 * with `add` (never overwritten); only session metadata transitions status.
 * Every write is wrapped in its own committed transaction, and every method
 * swallows errors internally — nothing here ever throws into the UI.
 */

export async function createSession(session: SessionRecord): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_SESSIONS).add(session));
    await transactionDone(tx);
  } catch (error) {
    log.error('createSession failed', error);
  }
}

export async function updateSessionStatus(
  id: string,
  status: SessionStatus,
  endTime?: number,
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const existing = await promisifyRequest<SessionRecord | undefined>(store.get(id));
    if (existing) {
      const updated: SessionRecord = { ...existing, status, endTime: endTime ?? existing.endTime };
      await promisifyRequest(store.put(updated));
    }
    await transactionDone(tx);
  } catch (error) {
    log.error('updateSessionStatus failed', error);
  }
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const record = await promisifyRequest<SessionRecord | undefined>(
      tx.objectStore(STORE_SESSIONS).get(id),
    );
    await transactionDone(tx);
    return record ?? null;
  } catch (error) {
    log.error('getSession failed', error);
    return null;
  }
}

/** Persist the backend linkage (event id + per-event HMAC secret) on a session. */
export async function setSessionBackend(
  id: string,
  eventId: string,
  hmacSecret: string,
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const existing = await promisifyRequest<SessionRecord | undefined>(store.get(id));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, eventId, hmacSecret }));
    }
    await transactionDone(tx);
  } catch (error) {
    log.error('setSessionBackend failed', error);
  }
}

export async function getActiveSession(): Promise<SessionRecord | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const index = tx.objectStore(STORE_SESSIONS).index('byStatus');
    const matches = await promisifyRequest<SessionRecord[]>(index.getAll('active'));
    await transactionDone(tx);
    if (matches.length === 0) {
      return null;
    }
    return matches.reduce((latest, candidate) =>
      candidate.startTime > latest.startTime ? candidate : latest,
    );
  } catch (error) {
    log.error('getActiveSession failed', error);
    return null;
  }
}

export async function appendChunk(chunk: RecordingChunk): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    // `add` (not `put`): append-only, refuses to overwrite an existing key.
    await promisifyRequest(tx.objectStore(STORE_RECORDINGS).add(chunk));
    await transactionDone(tx);
  } catch (error) {
    log.error('appendChunk failed', error);
  }
}

export async function appendLocation(point: LocationPoint): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_LOCATIONS, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_LOCATIONS).add(point));
    await transactionDone(tx);
  } catch (error) {
    // A duplicate [sessionId, timestamp] key is ignored — append-only.
    log.error('appendLocation failed', error);
  }
}

export async function getSessionChunks(sessionId: string): Promise<RecordingChunk[]> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_RECORDINGS, 'readonly');
    const index = tx.objectStore(STORE_RECORDINGS).index('bySession');
    const chunks = await promisifyRequest<RecordingChunk[]>(index.getAll(sessionId));
    await transactionDone(tx);
    return chunks.sort((a, b) => a.sequence - b.sequence);
  } catch (error) {
    log.error('getSessionChunks failed', error);
    return [];
  }
}

export async function getSessionLocations(sessionId: string): Promise<LocationPoint[]> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_LOCATIONS, 'readonly');
    const index = tx.objectStore(STORE_LOCATIONS).index('bySession');
    const points = await promisifyRequest<LocationPoint[]>(index.getAll(sessionId));
    await transactionDone(tx);
    return points.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    log.error('getSessionLocations failed', error);
    return [];
  }
}

export async function appendTranscriptFragment(fragment: TranscriptFragment): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_TRANSCRIPTS).add(fragment));
    await transactionDone(tx);
  } catch (error) {
    log.error('appendTranscriptFragment failed', error);
  }
}

export async function getTranscriptFragments(sessionId: string): Promise<TranscriptFragment[]> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readonly');
    const index = tx.objectStore(STORE_TRANSCRIPTS).index('bySession');
    const fragments = await promisifyRequest<TranscriptFragment[]>(index.getAll(sessionId));
    await transactionDone(tx);
    return fragments.sort((a, b) => a.sequence - b.sequence);
  } catch (error) {
    log.error('getTranscriptFragments failed', error);
    return [];
  }
}

export async function appendClassification(
  sessionId: string,
  classification: Classification,
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_CLASSIFICATIONS, 'readwrite');
    const record: StoredClassification = { sessionId, ...classification };
    await promisifyRequest(tx.objectStore(STORE_CLASSIFICATIONS).add(record));
    await transactionDone(tx);
  } catch (error) {
    log.error('appendClassification failed', error);
  }
}

export async function getClassifications(sessionId: string): Promise<StoredClassification[]> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_CLASSIFICATIONS, 'readonly');
    const index = tx.objectStore(STORE_CLASSIFICATIONS).index('bySession');
    const records = await promisifyRequest<StoredClassification[]>(index.getAll(sessionId));
    await transactionDone(tx);
    return records.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    log.error('getClassifications failed', error);
    return [];
  }
}

export async function getLatestClassification(
  sessionId: string,
): Promise<StoredClassification | null> {
  const all = await getClassifications(sessionId);
  return all.length > 0 ? all[all.length - 1]! : null;
}

// --- Upload queue (W5) ---

export async function enqueueUpload(item: UploadQueueItem): Promise<number> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_UPLOAD_QUEUE, 'readwrite');
    const key = await promisifyRequest(tx.objectStore(STORE_UPLOAD_QUEUE).add(item));
    await transactionDone(tx);
    return key as number;
  } catch (error) {
    log.error('enqueueUpload failed', error);
    return -1;
  }
}

export async function getQueuedUploads(): Promise<UploadQueueItem[]> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_UPLOAD_QUEUE, 'readonly');
    const items = await promisifyRequest<UploadQueueItem[]>(
      tx.objectStore(STORE_UPLOAD_QUEUE).getAll(),
    );
    await transactionDone(tx);
    return items.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  } catch (error) {
    log.error('getQueuedUploads failed', error);
    return [];
  }
}

export async function updateQueuedUpload(item: UploadQueueItem): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_UPLOAD_QUEUE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_UPLOAD_QUEUE).put(item));
    await transactionDone(tx);
  } catch (error) {
    log.error('updateQueuedUpload failed', error);
  }
}

export async function deleteQueuedUpload(id: number): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_UPLOAD_QUEUE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_UPLOAD_QUEUE).delete(id));
    await transactionDone(tx);
  } catch (error) {
    log.error('deleteQueuedUpload failed', error);
  }
}

/**
 * Called on launch. Any session still marked `active` is stale — the browser
 * killed its capture on the previous reload — so mark it `interrupted`. Chunks
 * already written remain intact.
 */
export async function markStaleSessionsInterrupted(): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const stale = await promisifyRequest<SessionRecord[]>(store.index('byStatus').getAll('active'));
    const now = Date.now();
    for (const session of stale) {
      await promisifyRequest(
        store.put({ ...session, status: 'interrupted', endTime: session.endTime ?? now }),
      );
    }
    await transactionDone(tx);
    if (stale.length > 0) {
      log.debug('marked stale sessions interrupted', stale.length);
    }
  } catch (error) {
    log.error('markStaleSessionsInterrupted failed', error);
  }
}
