import { sha256Hex } from '@blackbox/shared';

/**
 * Stable per-device identifier (the v0 "account UUID"). Generated once on first
 * launch and kept in localStorage. The raw id never leaves the device; only its
 * sha256 hash (`userHash`) is sent to the backend.
 */
const DEVICE_ID_KEY = 'stillpoint:device-id';

export function getDeviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    /* localStorage unavailable */
  }
  if (!id) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      /* localStorage unavailable; id is still stable for this page lifetime */
    }
  }
  return id;
}

export function getUserHash(): Promise<string> {
  return sha256Hex(new TextEncoder().encode(getDeviceId()));
}
