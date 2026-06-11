/**
 * Permission priming (Fix Brief 1 #7/#8). Microphone + location permission are
 * requested ONCE during onboarding, from a real user gesture — never at
 * activation time, where a permission dialog mid-alert would be catastrophic.
 *
 * We acquire the mic stream just long enough to trigger the OS grant, then stop
 * the tracks immediately (we are priming the permission, not recording yet), and
 * take a single geolocation fix to prime location.
 *
 * Platform honesty: on an installed PWA / Android Chrome the grant persists and
 * activation will not re-prompt. iOS Safari re-prompts camera/mic aggressively
 * even when "installed" — full persistence requires the Capacitor native shell
 * (v1). This priming is still the right call: it moves the prompt out of the
 * alert path on every platform that honors it.
 */

import { log } from '@/lib/log';

export interface PermissionResult {
  mic: boolean;
  location: boolean;
}

async function primeMic(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch (error) {
    log.error('mic permission priming failed', error);
    return false;
  }
}

function primeLocation(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      (error) => {
        log.error('location permission priming failed', error.message);
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

/** Request mic + location together from a single user gesture. */
export async function primePermissions(): Promise<PermissionResult> {
  // Run sequentially: some browsers dislike two simultaneous permission prompts.
  const mic = await primeMic();
  const location = await primeLocation();
  return { mic, location };
}
