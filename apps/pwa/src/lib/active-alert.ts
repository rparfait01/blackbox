import { useEffect, useState } from 'react';

import { getActiveSession } from '@/lib/storage';
import type { SessionRecord } from '@/lib/storage';

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
