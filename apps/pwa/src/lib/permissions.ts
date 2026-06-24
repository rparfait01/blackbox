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
import { saveGrants } from '@/lib/readiness';

export interface PermissionResult {
  mic: boolean;
  /** Camera is optional — captured separately so onboarding can report it honestly. */
  camera: boolean;
  location: boolean;
}

async function primeMicAndCamera(): Promise<{ mic: boolean; camera: boolean }> {
  // Prime BOTH mic and camera in one grant so overt activation never hits a
  // fresh camera prompt mid-alert (Fix Brief 6 LT5-6). If the camera is absent
  // or denied, fall back to priming the mic alone — mic is required, camera is not.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const camera = stream.getVideoTracks().length > 0;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return { mic: true, camera };
  } catch {
    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of audioOnly.getTracks()) {
        track.stop();
      }
      return { mic: true, camera: false };
    } catch (error) {
      log.error('mic permission priming failed', error);
      return { mic: false, camera: false };
    }
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

/** Request mic + camera + location from a single user gesture, and persist the
 *  grant snapshot so readiness can be reflected on later launches without a
 *  re-prompt (and so iOS, which cannot query, has a stored truth). */
export async function primePermissions(): Promise<PermissionResult> {
  // Run sequentially: some browsers dislike two simultaneous permission prompts.
  const { mic, camera } = await primeMicAndCamera();
  const location = await primeLocation();
  saveGrants({ mic, camera, location });
  return { mic, camera, location };
}
