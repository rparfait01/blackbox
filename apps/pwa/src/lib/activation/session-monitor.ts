import { signRequest } from '@blackbox/shared';

import { log } from '@/lib/log';
import { API_BASE_URL, uploadsEnabled } from '@/lib/env';
import { getSession } from '@/lib/storage';

/**
 * Session monitor. Polls GET /v1/events/:id/delivery-status for one purpose:
 * closure teardown. When the contact approves closure, the event flips to
 * `closed` / `contact_approval`; the monitor then runs the teardown callback
 * (stops capture, geolocation, uploads) and returns Stillpoint to its dormant
 * look — visually identical, recording actually stopped.
 *
 * There is deliberately NO on-device feedback during an active session. BLACK
 * BOX records and reaches; it does not reassure. Like an aircraft black box, the
 * person being recorded gets no signal that it is recording. (An earlier build
 * fired a confirmation haptic on delivery; that was removed from v0 entirely.)
 *
 * The eventId + per-event HMAC secret are created lazily by the upload pipeline,
 * so the monitor reads them from the session record each tick until they exist.
 * It is covert: no UI output, and all errors are swallowed.
 */

const POLL_INTERVAL_MS = 2000;

interface MonitorState {
  sessionId: string;
  onClosureConfirmed: () => void;
  timer: number | null;
  stopped: boolean;
}

let current: MonitorState | null = null;

interface DeliveryStatus {
  delivered: boolean;
  channel: string | null;
  deliveredAt: number | null;
  status: string;
  closedBy: string | null;
}

async function fetchStatus(eventId: string, secret: string): Promise<DeliveryStatus | null> {
  const path = `/v1/events/${eventId}/delivery-status`;
  const timestamp = Date.now();
  const body = new Uint8Array(0);
  const signed = await signRequest({ secret, eventId, method: 'GET', path, timestamp, body });
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', headers: { ...signed } });
  if (response.status !== 200) {
    return null;
  }
  return (await response.json()) as DeliveryStatus;
}

async function tick(state: MonitorState): Promise<void> {
  if (state.stopped) {
    return;
  }
  try {
    const session = await getSession(state.sessionId);
    if (!session?.eventId || !session.hmacSecret) {
      return; // event not created yet — wait for the upload pipeline
    }
    const status = await fetchStatus(session.eventId, session.hmacSecret);
    if (!status) {
      return;
    }

    // Any server-side closure tears the session down: contact pin-approval OR a
    // contact "stand down". (Duress never flips status, so recording correctly
    // continues; the user cannot close their own session — activation is
    // committal.)
    if (status.status === 'closed') {
      const callback = state.onClosureConfirmed;
      stopSessionMonitor();
      callback();
    }
  } catch (error) {
    log.error('session monitor tick failed', error);
  }
}

export function startSessionMonitor(sessionId: string, onClosureConfirmed: () => void): void {
  if (!uploadsEnabled) {
    return; // no backend → no closure path; recording stays entirely local
  }
  stopSessionMonitor();
  const state: MonitorState = {
    sessionId,
    onClosureConfirmed,
    timer: null,
    stopped: false,
  };
  current = state;
  state.timer = window.setInterval(() => {
    void tick(state);
  }, POLL_INTERVAL_MS);
  // Run an immediate first tick so an already-approved closure is caught fast.
  void tick(state);
}

export function stopSessionMonitor(): void {
  if (!current) {
    return;
  }
  current.stopped = true;
  if (current.timer !== null) {
    window.clearInterval(current.timer);
  }
  current = null;
}
