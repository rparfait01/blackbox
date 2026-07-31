import { useEffect, useState } from 'react';

import { useActiveAlert } from '@/lib/active-alert';
import { log } from '@/lib/log';

/**
 * Headless service-worker updater (Brief 13/14 B1 + Brief 21 §2). The installed
 * PWA cannot be hard-reset on the phone, so a stale build could otherwise live
 * forever. This registers the SW, checks for a newer build on an interval AND on
 * every foreground/resume, and applies it — SAFELY, gated on alert state:
 *
 *  - DORMANT: apply automatically. The waiting worker is told to skipWaiting, it
 *    clientsClaim()s, and `controllerchange` reloads onto the fresh build. Silent —
 *    currency by default.
 *  - LIVE ALERT (either mode): DEFER. Never skipWaiting, never reload — that would
 *    tear down the capture session / coordinator WebSocket mid-alert. The waiting
 *    worker is held; the instant the alert clears (alertActive → false) the effect
 *    below re-runs and applies it automatically.
 *
 * It renders NOTHING — ever. There is no banner or indicator, so it can never be a
 * tell in Hidden and the §0a byte-identical facade holds under every condition.
 * Currency is verifiable only by the build stamp in Settings (Visible), which
 * reflects the actually-running bundle. The first-ever install (no prior
 * controller) never reloads — only true updates do — so there is no reload loop.
 */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

export function UpdateBanner(): null {
  const alertActive = useActiveAlert();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
      return;
    }
    const hadController = navigator.serviceWorker.controller != null;
    let interval: number | undefined;
    let registration: ServiceWorkerRegistration | null = null;

    const offerWaiting = (sw: ServiceWorker | null): void => {
      if (sw) {
        setWaiting(sw);
      }
    };
    const watchInstalling = (reg: ServiceWorkerRegistration): void => {
      const sw = reg.installing;
      if (!sw) {
        return;
      }
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          offerWaiting(reg.waiting);
        }
      });
    };
    // Ask the browser to re-fetch sw.js and detect a newer build. Every build has a
    // fresh id, so the SW is byte-changed and an update is found when one exists.
    const check = (): void => {
      if (registration) {
        void registration.update();
      }
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        registration = reg;
        offerWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => watchInstalling(reg));
        interval = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      })
      .catch((error) => log.error('sw register failed', error));

    // Check on every foreground/resume (Brief 21 §2) — an installed PWA is usually
    // resumed, not cold-launched, so an interval alone misses updates for a while.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        check();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    let reloading = false;
    const onControllerChange = (): void => {
      // Only reload for an actual update, never the first install.
      if (reloading || !hadController) {
        return;
      }
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  // Apply automatically while DORMANT; DEFER while an alert is live. When the alert
  // clears, this effect re-runs (alertActive dep) and applies the held update — so
  // an update that arrives mid-alert lands the moment the session closes.
  useEffect(() => {
    if (waiting && !alertActive) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }, [waiting, alertActive]);

  // Renders nothing under any condition — no banner, no indicator, no tell.
  return null;
}
