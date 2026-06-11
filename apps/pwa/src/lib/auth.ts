/**
 * Client-side session + display-mode state (W8A). Stored in localStorage so the
 * root route can decide deterministically on first render (no flicker, no
 * fallback drift). The session token is HMAC-signed by the Worker; we never
 * trust it for anything beyond "which screen to show" — every protected call is
 * re-validated server-side.
 */

export type DisplayMode = 'direct' | 'covert';

const TOKEN_KEY = 'bb:sessionToken';
const MODE_KEY = 'bb:displayMode';
const SETUP_KEY = 'bb:setupComplete';
const USER_KEY = 'bb:user';

export interface CachedUser {
  name: string;
  email: string;
}

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function getSessionToken(): string | null {
  return get(TOKEN_KEY);
}

export function getDisplayMode(): DisplayMode | null {
  const v = get(MODE_KEY);
  return v === 'direct' || v === 'covert' ? v : null;
}

export function setDisplayMode(mode: DisplayMode): void {
  set(MODE_KEY, mode);
}

export function isSetupComplete(): boolean {
  return get(SETUP_KEY) === '1' || getSessionToken() != null;
}

export function getCachedUser(): CachedUser | null {
  const raw = get(USER_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as CachedUser;
  } catch {
    return null;
  }
}

/** Persist a completed sign-in/sign-up. */
export function setSession(token: string, mode: DisplayMode, user: CachedUser): void {
  set(TOKEN_KEY, token);
  set(MODE_KEY, mode);
  set(USER_KEY, JSON.stringify(user));
  set(SETUP_KEY, '1');
}

export function clearSession(): void {
  del(TOKEN_KEY);
  del(MODE_KEY);
  del(USER_KEY);
  del(SETUP_KEY);
}
