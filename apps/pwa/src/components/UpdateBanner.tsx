import { useEffect, useState } from 'react';

import { useActiveAlert } from '@/lib/active-alert';
import { log } from '@/lib/log';

/**
 * Self-update path (Brief 13/14 B1). The user cannot hard-reset the installed PWA
 * on their phone, so a stale build could otherwise live forever. This registers
 * the service worker, polls for a newer build every minute while the app is open,
 * and applies it:
 *
 *  - DORMANT (no active alert): the update is applied AUTOMATICALLY — the waiting
 *    worker is told to skipWaiting, it clientsClaim()s, and `controllerchange`
 *    reloads the page onto the fresh build. No tap, no hard reset.
 *  - ACTIVE alert: auto-apply is suppressed (a reload would tear down the
 *    recording session). A single generic "Reload" banner is shown so the user
 *    can choose to apply it; otherwise it applies automatically once the alert
 *    ends. The copy never reveals the app's true purpose (covert-safe).
 *
 * The first-ever install (no prior controller) does NOT reload — only true
 * updates do — so there is no first-load reload loop.
 */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

export function UpdateBanner(): JSX.Element | null {
  const alertActive = useActiveAlert();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
      return;
    }
    // Whether a controller already exists at startup — distinguishes a true update
    // (reload) from the first install (do not reload).
    const hadController = navigator.serviceWorker.controller != null;
    let interval: number | undefined;

    const offerWaiting = (sw: ServiceWorker | null): void => {
      if (sw) {
        setWaiting(sw);
      }
    };
    const watchInstalling = (registration: ServiceWorkerRegistration): void => {
      const sw = registration.installing;
      if (!sw) {
        return;
      }
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          offerWaiting(registration.waiting);
        }
      });
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        offerWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => watchInstalling(registration));
        interval = window.setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      })
      .catch((error) => log.error('sw register failed', error));

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
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  // Apply automatically while dormant; defer while an alert is live.
  useEffect(() => {
    if (waiting && !alertActive) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }, [waiting, alertActive]);

  // The banner only appears during an active alert (auto-apply is paused then),
  // giving the user a deliberate, safe way to update mid-session if they choose.
  if (!waiting || !alertActive) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[100] flex items-center justify-between gap-3 border-t border-white/10 bg-black/85 px-5 py-3 text-sm text-white backdrop-blur">
      <span className="text-white/80">A new version is ready.</span>
      <button
        type="button"
        onClick={() => waiting.postMessage({ type: 'SKIP_WAITING' })}
        className="rounded-full border border-white/40 px-4 py-1.5 font-mono text-[12px] uppercase tracking-[0.1em] text-white"
      >
        Reload
      </button>
    </div>
  );
}
