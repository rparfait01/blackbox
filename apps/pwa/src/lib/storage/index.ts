import { log } from '@/lib/log';
import {
  getDB,
  promisifyRequest,
  transactionDone,
  STORE_SESSIONS,
  STORE_RECORDINGS,
  STORE_LOCATIONS,
  STORE_TRANSCRIPTS,
} from './db';
import type {
  LocationPoint,
  RecordingChunk,
  SessionRecord,
  SessionStatus,
  TranscriptFragment,
} from './types';

export type {
  ActivationSource,
  CaptureMode,
  LocationPoint,
  RecordingChunk,
  SessionRecord,
  SessionStatus,
  TranscriptFragment,
} from './types';

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
