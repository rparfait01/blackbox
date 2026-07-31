/**
 * EventChannel Durable Object (Fix Brief 16 §4). One instance per event
 * (id = idFromName(eventId)). The open coordinator dashboard connects here over a
 * WebSocket and the worker pushes a lightweight "changed" signal the instant any
 * lifecycle event fires (close request, support assent, closure, duress,
 * tampering escalation). The dashboard re-fetches /state on the signal — live,
 * server-pushed, never polled, never re-emailed.
 *
 * Uses the WebSocket Hibernation API (acceptWebSocket / getWebSockets) so idle
 * connections cost nothing and survive DO eviction. Inbound messages are limited
 * to a keepalive ping; the channel is push-only.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from './types';

export class EventChannel {
  // The channel is pure WebSocket fan-out; it needs no env (state only).
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal: a lifecycle change → fan out to every connected dashboard.
    if (url.pathname.endsWith('/broadcast')) {
      const body = (await req.json().catch(() => ({}))) as { kind?: string };
      const msg = JSON.stringify({ type: 'changed', kind: body.kind ?? 'state' });
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {
          /* a dead socket is dropped on its close event */
        }
      }
      return new Response('ok');
    }

    // Dashboard WebSocket upgrade.
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      try {
        server.send(JSON.stringify({ type: 'ready' }));
      } catch {
        /* ignore */
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('bad request', { status: 400 });
  }

  // Push-only channel: the sole accepted inbound message is a keepalive ping.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') {
      try {
        ws.send('pong');
      } catch {
        /* ignore */
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Push a "changed" signal to every dashboard subscribed to this event. Best-
 *  effort and fire-and-forget — never blocks or throws into a lifecycle write. */
export async function broadcastEventChange(env: Env, eventId: string, kind: string): Promise<void> {
  try {
    if (!env.EVENT_CHANNEL) return;
    const stub = env.EVENT_CHANNEL.get(env.EVENT_CHANNEL.idFromName(eventId));
    await stub.fetch('https://event-channel/broadcast', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  } catch {
    /* the dashboard's polling fallback covers any missed push */
  }
}
