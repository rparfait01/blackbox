import { signRequest } from '@blackbox/shared';
import type { Classification } from '@blackbox/classifier';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getUserHash } from '@/lib/device';
import { fireDeliveryHaptic } from '@/lib/activation/haptic';
import {
  deleteQueuedUpload,
  enqueueUpload,
  getQueuedUploads,
  getSession,
  setSessionBackend,
  updateQueuedUpload,
} from '@/lib/storage';
import type { UploadQueueItem } from '@/lib/storage';
import type { GeoFix } from '@/lib/geolocation/location-tracker';

/**
 * Upload pipeline (W5). Everything to be uploaded goes through a single
 * IndexedDB-backed queue drained by one loop with exponential backoff, so it
 * survives offline windows and page reloads. The Worker event is created lazily
 * (on first drain) so activation never blocks on the network — and so an offline
 * activation still queues data that flushes when connectivity returns.
 *
 * Covert: nothing here ever changes the UI. The only user-perceptible effect is
 * the two-pulse haptic, fired exactly once per session on the first successful
 * chunk upload (which implies the cloud has accepted the event).
 */

interface SessionContext {
  sessionId: string;
  source: string;
  startTime: number;
  eventId?: string;
  hmacSecret?: string;
}

const MAX_BACKOFF_MS = 30_000;
const LOCATION_FLUSH_MS = 5000;

const contexts = new Map<string, SessionContext>();
const locationBatch = new Map<string, Array<Record<string, number>>>();
const hapticFired = new Set<string>();

let timersStarted = false;
let drainScheduled = false;
let draining = false;

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
}

function ensureTimers(): void {
  if (timersStarted) {
    return;
  }
  timersStarted = true;
  window.setInterval(flushLocations, LOCATION_FLUSH_MS);
  window.addEventListener('online', () => scheduleDrain(0));
}

function scheduleDrain(delayMs: number): void {
  if (drainScheduled) {
    return;
  }
  drainScheduled = true;
  window.setTimeout(() => {
    drainScheduled = false;
    void drainQueue();
  }, delayMs);
}

/** Register a live session as uploadable and kick the drain loop. */
export function registerUploadSession(session: {
  sessionId: string;
  source: string;
  startTime: number;
}): void {
  if (!uploadsEnabled) {
    return;
  }
  contexts.set(session.sessionId, { ...session });
  ensureTimers();
  scheduleDrain(0);
}

export function uploadChunk(
  sessionId: string,
  sequence: number,
  blob: Blob,
  mimeType: string,
): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'chunk',
    sequence,
    mimeType,
    blob,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

export function uploadLocation(sessionId: string, fix: GeoFix): void {
  if (!uploadsEnabled) {
    return;
  }
  const batch = locationBatch.get(sessionId) ?? [];
  batch.push({
    timestamp: fix.timestamp,
    lat: fix.lat,
    lon: fix.lon,
    ...(fix.accuracy !== null ? { accuracy: fix.accuracy } : {}),
    ...(fix.speed !== null ? { speed: fix.speed } : {}),
  });
  locationBatch.set(sessionId, batch);
}

export function uploadClassification(sessionId: string, classification: Classification): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'classifications',
    payload: { items: [classification] },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

export function uploadTranscript(sessionId: string, sequence: number, text: string): void {
  if (!uploadsEnabled) {
    return;
  }
  void enqueueUpload({
    sessionId,
    kind: 'transcripts',
    payload: { fragments: [{ sequence, text, isFinal: true }] },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  }).then(() => scheduleDrain(0));
}

/** On launch, resume draining any uploads left queued by a previous session. */
export async function resumeUploads(): Promise<void> {
  if (!uploadsEnabled) {
    return;
  }
  const pending = await getQueuedUploads();
  if (pending.length > 0) {
    ensureTimers();
    scheduleDrain(0);
  }
}

function flushLocations(): void {
  for (const [sessionId, batch] of locationBatch) {
    if (batch.length === 0) {
      continue;
    }
    const points = batch.splice(0, batch.length);
    void enqueueUpload({
      sessionId,
      kind: 'locations',
      payload: { points },
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    }).then(() => scheduleDrain(0));
  }
}

async function resolveContext(sessionId: string): Promise<SessionContext | null> {
  const existing = contexts.get(sessionId);
  if (existing) {
    return existing;
  }
  const row = await getSession(sessionId);
  if (!row) {
    return null;
  }
  const ctx: SessionContext = {
    sessionId,
    source: row.source,
    startTime: row.startTime,
    eventId: row.eventId,
    hmacSecret: row.hmacSecret,
  };
  contexts.set(sessionId, ctx);
  return ctx;
}

async function ensureEvent(ctx: SessionContext): Promise<boolean> {
  if (ctx.eventId && ctx.hmacSecret) {
    return true;
  }
  const userHash = await getUserHash();
  const response = await fetch(`${API_BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userHash, source: ctx.source, startTime: ctx.startTime }),
  });
  if (response.status !== 201) {
    return false;
  }
  const data = (await response.json()) as { eventId: string; hmacSecret: string };
  ctx.eventId = data.eventId;
  ctx.hmacSecret = data.hmacSecret;
  await setSessionBackend(ctx.sessionId, data.eventId, data.hmacSecret);
  return true;
}

async function sendItem(item: UploadQueueItem, ctx: SessionContext): Promise<boolean> {
  const eventId = ctx.eventId;
  const secret = ctx.hmacSecret;
  if (!eventId || !secret) {
    return false;
  }

  let path: string;
  let body: Uint8Array;
  const headers: Record<string, string> = {};

  if (item.kind === 'chunk') {
    path = `/v1/events/${eventId}/chunks/${item.sequence}`;
    body = new Uint8Array(await (item.blob ?? new Blob()).arrayBuffer());
    headers['X-Mime-Type'] = item.mimeType ?? 'application/octet-stream';
    headers['Content-Type'] = 'application/octet-stream';
  } else {
    path = `/v1/events/${eventId}/${item.kind}`;
    body = new TextEncoder().encode(JSON.stringify(item.payload ?? {}));
    headers['Content-Type'] = 'application/json';
  }

  const timestamp = Date.now();
  const signed = await signRequest({ secret, eventId, method: 'POST', path, timestamp, body });
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, ...signed },
    body: body as BodyInit,
  });
  if (response.status >= 200 && response.status < 300) {
    if (item.kind === 'chunk' && !hapticFired.has(ctx.sessionId)) {
      hapticFired.add(ctx.sessionId);
      fireDeliveryHaptic();
    }
    return true;
  }
  return false;
}

async function drainQueue(): Promise<void> {
  if (draining) {
    return;
  }
  if (!navigator.onLine) {
    scheduleDrain(5000);
    return;
  }
  draining = true;
  try {
    const items = await getQueuedUploads();
    const now = Date.now();
    for (const item of items) {
      if (item.nextAttemptAt > now) {
        continue;
      }
      const ctx = await resolveContext(item.sessionId);
      if (!ctx) {
        continue;
      }
      try {
        const ready = await ensureEvent(ctx);
        if (!ready || !(await sendItem(item, ctx))) {
          throw new Error('upload failed');
        }
        if (item.id !== undefined) {
          await deleteQueuedUpload(item.id);
        }
      } catch (error) {
        log.error('upload item failed; will retry', error);
        item.attempts += 1;
        item.nextAttemptAt = Date.now() + backoff(item.attempts);
        await updateQueuedUpload(item);
        scheduleDrain(backoff(item.attempts));
        return; // preserve order; back off before the next pass
      }
    }
    const remaining = await getQueuedUploads();
    if (remaining.length > 0) {
      scheduleDrain(2000);
    }
  } finally {
    draining = false;
  }
}
