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

/**
 * The three answers that matter, kept distinct on purpose.
 *
 *   ok      — the server told us the event's status.
 *   gone    — the server positively says this event does not exist (404/410). The local
 *             session is a phantom: there is nothing to close, nothing to dispatch from.
 *   unknown — we could not ASK (offline, timeout, 5xx). NOT an answer, and must never be
 *             treated as one: the device may be recording a real emergency with no signal.
 *
 * Collapsing `gone` and `unknown` into a single null is what produced a phantom alert
 * that survived hard resets — the monitor saw null, returned, and the local session stayed
 * `active` forever with no server event behind it.
 */
type StatusProbe =
  | { kind: 'ok'; status: DeliveryStatus }
  | { kind: 'gone' }
  | { kind: 'unknown' };

async function fetchStatus(eventId: string, secret: string): Promise<StatusProbe> {
  const path = `/v1/events/${eventId}/delivery-status`;
  const timestamp = Date.now();
  const body = new Uint8Array(0);
  const signed = await signRequest({ secret, eventId, method: 'GET', path, timestamp, body });
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', headers: { ...signed } });
  } catch {
    return { kind: 'unknown' }; // no network — say nothing, change nothing.
  }
  // 404 is hmacAuth's answer for an event row that is not there; 410 is a retired route.
  if (response.status === 404 || response.status === 410) {
    return { kind: 'gone' };
  }
  if (response.status !== 200) {
    return { kind: 'unknown' }; // 5xx, auth hiccup, anything else — not a verdict.
  }
  try {
    return { kind: 'ok', status: (await response.json()) as DeliveryStatus };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * One-shot read of the server's current lifecycle status for an event ('active' |
 * 'closed' | ...), or null when it can't be read. Used to reconcile a possibly
 * stale local 'active' session against server truth before deduping a trigger
 * against it (Brief 25).
 */
export async function fetchEventStatus(eventId: string, secret: string): Promise<string | null> {
  const probe = await fetchStatus(eventId, secret);
  // 'gone' reports as closed: for every caller, an event the server does not have is an
  // event that cannot be live. Only an unreachable server yields null (= "don't know").
  if (probe.kind === 'gone') return 'closed';
  return probe.kind === 'ok' ? probe.status.status : null;
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
    const probe = await fetchStatus(session.eventId, session.hmacSecret);

    // We could not ask. Change nothing — the device may be recording a real emergency
    // with no signal, and an absent answer is not permission to end an alert.
    if (probe.kind === 'unknown') {
      return;
    }

    // The server does not have this event. There is nothing to close and nothing to
    // dispatch from, so holding a local "ALERT ACTIVE" is a lie the UI must not tell.
    // This is the phantom-alert case: previously indistinguishable from "couldn't ask",
    // so the session stayed active across every reload.
    if (probe.kind === 'gone') {
      const callback = state.onClosureConfirmed;
      stopSessionMonitor();
      callback();
      return;
    }

    // Any server-side closure tears the session down: contact pin-approval OR a
    // contact "stand down". (Duress never flips status, so recording correctly
    // continues; the user cannot close their own session — activation is
    // committal.)
    if (probe.status.status === 'closed') {
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
