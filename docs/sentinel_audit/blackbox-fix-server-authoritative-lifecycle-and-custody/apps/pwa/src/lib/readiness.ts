/**
 * Readiness (Fix Brief 15 §B/§C). A granted capture permission can be revoked
 * later in OS settings — without monitoring, the system would fail silently in
 * an emergency, the exact failure §B exists to prevent. This module is the
 * single source of truth for "can BLACK BOX actually do its job right now."
 *
 * Re-VERIFY, never re-PROMPT: the live state comes from the Permissions API
 * (`navigator.permissions.query`), which reports the current grant without
 * showing a dialog. Where that API is unavailable — notably iOS Safari, which
 * does not expose `microphone`/`camera` queries — we fall back to the grant
 * captured at onboarding. That is the honest best we can do on iOS; it never
 * re-prompts and it never silently claims readiness it cannot verify.
 *
 * Residual PWA limitation (do not paper over): capture cannot run while the
 * screen is locked or the app is backgrounded. That is a platform constraint of
 * the web, not a readiness state — it is surfaced to the user in copy, not here.
 */

import { log } from '@/lib/log';

export type Grant = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface Readiness {
  mic: Grant;
  location: Grant;
  /** Camera is OPTIONAL — its absence never makes the system "not ready". */
  camera: Grant;
  /** True only when every REQUIRED grant (mic + location) is granted. */
  ready: boolean;
  /** Human labels of the missing REQUIRED grants, for a precise NOT-READY message. */
  missing: string[];
}

const GRANTS_KEY = 'bb.permGrants';

export interface StoredGrants {
  mic: boolean;
  camera: boolean;
  location: boolean;
  at: number;
}

/** Persist the onboarding/self-test grant snapshot so launches can reflect
 *  readiness without re-prompting (and so iOS, which can't query, has a truth). */
export function saveGrants(g: { mic: boolean; camera: boolean; location: boolean }): void {
  try {
    localStorage.setItem(GRANTS_KEY, JSON.stringify({ ...g, at: Date.now() }));
  } catch (error) {
    log.error('saveGrants failed', error);
  }
}

export function loadGrants(): StoredGrants | null {
  try {
    const raw = localStorage.getItem(GRANTS_KEY);
    return raw ? (JSON.parse(raw) as StoredGrants) : null;
  } catch {
    return null;
  }
}

async function queryPermission(name: string): Promise<Grant> {
  try {
    // Guard: iOS Safari throws/rejects for 'microphone'/'camera'.
    if (!('permissions' in navigator) || !navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return status.state as Grant;
  } catch {
    return 'unknown';
  }
}

/** Resolve one permission: live query wins; when the API can't answer, fall
 *  back to the last persisted grant (granted/denied), else 'unknown'. */
function reconcile(live: Grant, stored: boolean | undefined): Grant {
  if (live !== 'unknown') return live;
  if (stored === true) return 'granted';
  if (stored === false) return 'denied';
  return 'unknown';
}

/** Re-verify all capture permissions. Safe to call on every launch / refresh. */
export async function checkReadiness(): Promise<Readiness> {
  const stored = loadGrants();
  const [micLive, locLive, camLive] = await Promise.all([
    queryPermission('microphone'),
    queryPermission('geolocation'),
    queryPermission('camera'),
  ]);
  const mic = reconcile(micLive, stored?.mic);
  const location = reconcile(locLive, stored?.location);
  const camera = reconcile(camLive, stored?.camera);

  const missing: string[] = [];
  if (mic !== 'granted') missing.push('Microphone');
  if (location !== 'granted') missing.push('Location');

  return { mic, location, camera, ready: missing.length === 0, missing };
}

/** The OS path to restore a revoked grant — shown on the NOT-READY fix step. */
export function osFixHint(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'On iPhone: Settings → Stillpoint (or Safari → Microphone/Location) → Allow.';
  }
  if (/Android/.test(ua)) {
    return 'On Android: long-press the app icon → App info → Permissions → allow Microphone and Location.';
  }
  return 'Open your browser site settings for this app and allow Microphone and Location.';
}
