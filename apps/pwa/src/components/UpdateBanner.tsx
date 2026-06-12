import { useEffect, useState } from 'react';

import { useActiveAlert } from '@/lib/active-alert';
import { log } from '@/lib/log';

/**
 * In-app "update available — reload" path (Brief 13 B1). The user cannot hard
 * reset the installed PWA on their phone, so a stale build could otherwise live
 * forever. This registers the service worker emitted by vite-plugin-pwa, polls
 * for a newer build every minute while the app is open, and — when one is waiting
 * — shows a single-tap "Reload" banner. Tapping it tells the waiting worker to
 * skipWaiting and reloads once it takes control, so the new build is live
 * immediately.
 *
 * Why native instead of virtual:pwa-register: the generated SW (registerType
 * 'prompt') already listens for the SKIP_WAITING message and clientsClaim()s, so
 * a handful of lines of native API gives us full control without dragging in
 * workbox-window. Registration is production-only (no /sw.js exists under `vite
 * dev`).
 *
 * The banner is suppressed during an active alert: reloading mid-event would tear
 * down the recording session, so the update waits until the alert is secured. The
 * copy is generic ("A new version is ready") so it never reveals the app's true
 * purpose on the covert surface.
 */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

export function UpdateBanner(): JSX.Element | null {
  const alertActive = useActiveAlert();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
      return;
    }
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
        // A new worker reaching 'installed' while one already controls the page
        // means a fresh build is waiting.
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          offerWaiting(registration.waiting);
        }
      });
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Already-waiting worker from a previous visit.
        offerWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => watchInstalling(registration));
        interval = window.setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      })
      .catch((error) => log.error('sw register failed', error));

    // When the new worker takes control, reload so the fresh assets are used.
    let reloading = false;
    const onControllerChange = (): void => {
      if (reloading) {
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

  if (!waiting || alertActive) {
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
