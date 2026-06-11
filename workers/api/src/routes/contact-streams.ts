/**
 * Server-Sent Events for the contact dashboard (W7). The Worker has no pub/sub
 * (no Durable Object here), so each stream is a bounded loop that polls D1 once
 * a second and emits only new rows, then ends after ~60s — the browser's
 * EventSource reconnects automatically. The dashboard treats SSE as a
 * latency enhancement; its 3s /state poll is the correctness guarantee, so a
 * dropped or unsupported stream degrades gracefully.
 */

import type { Context } from 'hono';
import type { Env, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const MAX_ITERATIONS = 60;
const TICK_MS = 1000;
const TRAIL_WINDOW_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseResponse(
  c: Ctx,
  produce: (send: (data: unknown) => void, isOpen: () => boolean) => Promise<void>,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const send = (data: unknown): void => {
    void writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await produce(send, () => open);
      } catch {
        /* swallow — the stream just ends and the client reconnects */
      } finally {
        open = false;
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
      }
    })(),
  );
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}

/** Emits `{ latestSequence }` each time a newer audio chunk lands. */
export function audioStream(c: Ctx, eventId: string): Response {
  let last = Number(c.req.query('since') ?? '-1');
  if (!Number.isFinite(last)) {
    last = -1;
  }
  return sseResponse(c, async (send, isOpen) => {
    for (let i = 0; i < MAX_ITERATIONS && isOpen(); i += 1) {
      const row = await c.env.DB.prepare(
        'SELECT sequence FROM chunks_index WHERE eventId = ? ORDER BY sequence DESC LIMIT 1',
      )
        .bind(eventId)
        .first<{ sequence: number }>();
      if (row && row.sequence > last) {
        last = row.sequence;
        send({ latestSequence: last });
      }
      await sleep(TICK_MS);
    }
  });
}

/** Emits `{ location, trail }` each time a newer location fix lands. */
export function locationStream(c: Ctx, eventId: string): Response {
  let lastTs = Number(c.req.query('since') ?? '0');
  if (!Number.isFinite(lastTs)) {
    lastTs = 0;
  }
  return sseResponse(c, async (send, isOpen) => {
    for (let i = 0; i < MAX_ITERATIONS && isOpen(); i += 1) {
      const row = await c.env.DB.prepare(
        'SELECT lat, lon, accuracyM, speed, timestamp FROM locations_index WHERE eventId = ? ORDER BY timestamp DESC LIMIT 1',
      )
        .bind(eventId)
        .first<{
          lat: number;
          lon: number;
          accuracyM: number | null;
          speed: number | null;
          timestamp: number;
        }>();
      if (row && row.timestamp > lastTs) {
        lastTs = row.timestamp;
        const trail = await c.env.DB.prepare(
          'SELECT lat, lon, timestamp FROM locations_index WHERE eventId = ? AND timestamp >= ? ORDER BY timestamp ASC',
        )
          .bind(eventId, Date.now() - TRAIL_WINDOW_MS)
          .all<{ lat: number; lon: number; timestamp: number }>();
        send({ location: row, trail: trail.results ?? [] });
      }
      await sleep(TICK_MS);
    }
  });
}
