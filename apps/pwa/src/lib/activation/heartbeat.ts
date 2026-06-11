import { hmacSha256Hex, signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getSession } from '@/lib/storage';

/**
 * Heartbeat + lost-beacon lifecycle (Fix Brief 1 #3).
 *
 * While a session is active the client pings `/v1/events/:id/heartbeat` every
 * 10s. The Worker records `lastHeartbeatAt` but MUST NOT auto-close on a missed
 * beat — a missed heartbeat means the device went dark, which ESCALATES, never
 * cancels. On `pagehide` we fire a `navigator.sendBeacon` to `/v1/events/:id/lost`
 * to mark the client lost (not cancelled) the instant the page is torn down.
 *
 * The eventId + per-event HMAC secret are minted lazily by the upload pipeline,
 * so each tick reads them from the session record until they exist. Covert: no
 * UI output, all errors swallowed.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;

interface HeartbeatState {
  sessionId: string;
  timer: number | null;
  stopped: boolean;
  pagehideHandler: (() => void) | null;
}

let current: HeartbeatState | null = null;

async function resolveBackend(sessionId: string): Promise<{ eventId: string; secret: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.eventId || !session.hmacSecret) {
    return null;
  }
  return { eventId: session.eventId, secret: session.hmacSecret };
}

async function ping(state: HeartbeatState): Promise<void> {
  if (state.stopped) {
    return;
  }
  try {
    const backend = await resolveBackend(state.sessionId);
    if (!backend) {
      return; // event not created yet — wait for the upload pipeline
    }
    const path = `/v1/events/${backend.eventId}/heartbeat`;
    const timestamp = Date.now();
    const body = new TextEncoder().encode(JSON.stringify({ at: timestamp }));
    const signed = await signRequest({
      secret: backend.secret,
      eventId: backend.eventId,
      method: 'POST',
      path,
      timestamp,
      body,
    });
    await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: body as BodyInit,
      keepalive: true,
    });
  } catch (error) {
    log.error('heartbeat ping failed', error);
  }
}

/**
 * Mark the client "lost" on pagehide via sendBeacon. sendBeacon can't carry
 * custom headers, so the payload is body-signed: sig = HMAC(secret, "LOST\n
 * <eventId>\n<timestamp>"). The Worker recomputes and verifies. This escalates,
 * never cancels — so even a forged beacon is fail-safe.
 */
async function sendLostBeacon(sessionId: string): Promise<void> {
  try {
    const backend = await resolveBackend(sessionId);
    if (!backend) {
      return;
    }
    const timestamp = Date.now();
    const sig = await hmacSha256Hex(backend.secret, `LOST\n${backend.eventId}\n${timestamp}`);
    const payload = JSON.stringify({ eventId: backend.eventId, timestamp, sig });
    const url = `${API_BASE_URL}/v1/events/${backend.eventId}/lost`;
    const blob = new Blob([payload], { type: 'application/json' });
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      navigator.sendBeacon(url, blob);
    } else {
      void fetch(url, { method: 'POST', body: payload, keepalive: true });
    }
  } catch (error) {
    log.error('lost beacon failed', error);
  }
}

export function startHeartbeat(sessionId: string): void {
  if (!uploadsEnabled) {
    return;
  }
  stopHeartbeat();
  const state: HeartbeatState = {
    sessionId,
    timer: null,
    stopped: false,
    pagehideHandler: null,
  };
  current = state;
  state.timer = window.setInterval(() => void ping(state), HEARTBEAT_INTERVAL_MS);
  void ping(state);

  // pagehide is the most reliable "page is going away" signal on mobile Safari
  // (more so than beforeunload/unload, which iOS often skips).
  const handler = (): void => {
    void sendLostBeacon(sessionId);
  };
  state.pagehideHandler = handler;
  window.addEventListener('pagehide', handler);
}

export function stopHeartbeat(): void {
  if (!current) {
    return;
  }
  current.stopped = true;
  if (current.timer !== null) {
    window.clearInterval(current.timer);
  }
  if (current.pagehideHandler) {
    window.removeEventListener('pagehide', current.pagehideHandler);
  }
  current = null;
}
