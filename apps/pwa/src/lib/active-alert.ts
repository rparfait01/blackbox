import { useEffect, useState } from 'react';
import { signRequest } from '@blackbox/shared';

import { getActiveSession } from '@/lib/storage';
import type { SessionRecord } from '@/lib/storage';
import { API_BASE_URL } from '@/lib/env';

/**
 * Active-alert lockdown (Fix Brief 8 P0). While an alert is active the user must
 * not be able to reach Settings (no editing contacts, guardian, code, or the
 * guardian on/off toggle mid-event). The server also enforces this (423), but the
 * UI must not even offer the entry point.
 *
 * `isAlertActive` is the pure, regression-pinned predicate (tested directly).
 */
export function isAlertActive(session: Pick<SessionRecord, 'status'> | null | undefined): boolean {
  return session?.status === 'active';
}

/**
 * True while an alert session is active. Re-checks on mount, on a short interval,
 * and when the tab regains visibility, so the lock survives a refresh (the active
 * session is re-hydrated from the server on launch — Fix Brief 6).
 */
export function useActiveAlert(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const session = await getActiveSession();
      if (!cancelled) {
        setActive(isAlertActive(session));
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 3000);
    const onVisible = (): void => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return active;
}

/**
 * The active alert's start time (epoch ms), or null when dormant. Same polling
 * lifecycle as useActiveAlert, sourced from the same active session — so the
 * elapsed-alert timer survives a refresh (it counts from the real activation
 * time, not from page load) and reverts to null the moment the alert is secured.
 */
export function useActiveAlertStart(): number | null {
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const session = await getActiveSession();
      if (!cancelled) {
        setStart(isAlertActive(session) ? (session?.startTime ?? null) : null);
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 3000);
    const onVisible = (): void => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return start;
}

/** The server's delivery truth for the live event (GET /v1/events/:id/delivery-status). */
export interface DeliveryStatus {
  coordinatorPathFailed: boolean;
  /** Recipients the cascade will actually attempt. 0 → nobody to notify. */
  recipientCount: number;
  /** Cascade exhausted with not one delivery landed → reached no one. */
  allChannelsFailed: boolean;
}

/**
 * Polls the server's delivery truth for the live event, every 5s. ONE poll feeds
 * both the §3 closure prompt and the honest status line, so the two can never
 * disagree about the same event.
 *
 * Returns null while unknown (no live event, first tick not back, fetch failed) —
 * callers MUST treat null as "don't know yet" and say nothing rather than guess.
 * This never gates or blocks anything: it is read-only display truth, polled off
 * the trigger path entirely.
 */
export function useDeliveryStatus(): DeliveryStatus | null {
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const session = await getActiveSession();
      if (!session || session.status !== 'active' || !session.eventId || !session.hmacSecret) {
        if (!cancelled) setStatus(null);
        return;
      }
      try {
        // Signed with the per-event secret, same as the session monitor.
        const path = `/v1/events/${session.eventId}/delivery-status`;
        const signed = await signRequest({
          secret: session.hmacSecret,
          eventId: session.eventId,
          method: 'GET',
          path,
          timestamp: Date.now(),
          body: new Uint8Array(0),
        });
        const res = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', headers: { ...signed } });
        if (res.status !== 200) return;
        const data = (await res.json()) as Partial<DeliveryStatus>;
        if (!cancelled) {
          setStatus({
            coordinatorPathFailed: !!data?.coordinatorPathFailed,
            recipientCount: typeof data?.recipientCount === 'number' ? data.recipientCount : 0,
            allChannelsFailed: !!data?.allChannelsFailed,
          });
        }
      } catch {
        /* leave the last value; the next tick retries */
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return status;
}

/**
 * §1: the ACTIVE-ALERT status line, derived from the server's real delivery
 * result — never a hardcoded claim. A safety tool must never tell someone their
 * contacts are being notified when nobody is. The four states:
 *
 *   unknown (null)  → "Recording" — true in EVERY state; claims nothing about reach
 *   0 recipients    → nobody to notify; recording still says so plainly
 *   all failed      → reached no one (Brief 23 §2: fail loud, never a success string)
 *   otherwise       → contacts are genuinely being notified
 *
 * Unknown deliberately degrades to the claim-nothing string rather than assuming
 * success: while the first poll is in flight the honest answer is "we're recording"
 * and nothing more. Pure + exported so the guard test can pin every branch.
 *
 * VISIBLE ONLY. The Hidden facade shows no status under any state (§0a) — a status
 * line there would be a tell. Never call this from a facade surface.
 */
export function activeStatusLine(status: DeliveryStatus | null): string {
  if (status == null) return 'Recording';
  if (status.recipientCount === 0) return 'No contacts to notify · Recording only';
  if (status.allChannelsFailed) return 'Could not reach contacts';
  return 'Contacts are being notified';
}

/**
 * §3: true once the COORDINATOR closure path has failed and the qualified
 * confirmer has escalated to the guardian — so the overt app can prompt the user
 * to request closure a SECOND time (which routes to the guardian). The covert
 * facade never surfaces this (the user simply re-does the gesture); only the overt
 * instrument shows the prompt.
 */
export function useCoordinatorPathFailed(): boolean {
  return useDeliveryStatus()?.coordinatorPathFailed ?? false;
}
