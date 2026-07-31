/**
 * Client-side session + display-mode state (W8A). Stored in localStorage so the
 * root route can decide deterministically on first render (no flicker, no
 * fallback drift). The session token is HMAC-signed by the Worker; we never
 * trust it for anything beyond "which screen to show" — every protected call is
 * re-validated server-side.
 */

export type DisplayMode = 'direct' | 'covert';

const TOKEN_KEY = 'blackbox.session';
const MODE_KEY = 'blackbox.displayMode';
const SETUP_KEY = 'blackbox.setupComplete';
const USER_KEY = 'blackbox.user';
const ENTITLEMENT_KEY = 'blackbox.entitlement';
const CONSOLE_KEY = 'blackbox.consoleLevel';

export interface CachedUser {
  name: string;
  email: string;
}

/**
 * 'unknown' = we have never been able to determine entitlement on THIS install (fresh
 * install / cache cleared / never online since). It is DISTINCT from 'unactivated', which
 * is a server-confirmed "no". This distinction is load-bearing for the offline arm gate
 * (see mayArmByCache): the arm affordance fails OPEN on 'unknown' so a survivor who
 * reinstalls with no signal is never locked out of arming (§0 — never require a network
 * call to arm). Only a server-confirmed 'unactivated' gates.
 */
export type EntitlementStatus = 'unknown' | 'unactivated' | 'activated';

export interface CachedEntitlement {
  status: EntitlementStatus;
  /** 'purchase_web' | 'purchase_ios' | 'org_code' | 'operator_grant' | null. An
   *  org_code / operator_grant source means the UI renders no price. */
  source: string | null;
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

/**
 * The account's cached entitlement (Brief 28 §2). Read to decide the ARM affordance
 * WITHOUT a network round-trip — an activated device arms and (the trigger always
 * fires regardless) works fully offline after first activation. Defaults to
 * 'unactivated' when nothing is cached yet.
 */
export function getCachedEntitlement(): CachedEntitlement {
  const raw = get(ENTITLEMENT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CachedEntitlement;
      if (parsed.status === 'activated' || parsed.status === 'unactivated') {
        return { status: parsed.status, source: parsed.source ?? null };
      }
    } catch {
      /* fall through to default */
    }
  }
  // Nothing cached → UNKNOWN, not unactivated. The caller decides; the arm gate treats
  // unknown as permissive so an offline reinstall is never a lockout.
  return { status: 'unknown', source: null };
}

/**
 * May this install ARM by cache alone (no network)? Fails OPEN on 'unknown' (§0): an
 * activated device, and a device that has never been able to check, both arm; only a
 * server-confirmed 'unactivated' returns false. Never gates the TRIGGER — the trigger
 * fires regardless of this.
 */
export function mayArmByCache(): boolean {
  return getCachedEntitlement().status !== 'unactivated';
}

/**
 * Cache the entitlement from a fresh GET /v1/me. Monotonic and never-re-locking to
 * mirror the server (§0): once 'activated' is cached it is NEVER overwritten back to
 * 'unactivated' — a transient/garbled/offline response can't strip an activated
 * device of its arm affordance. Only a real activation flips it forward.
 */
export function cacheEntitlement(next: CachedEntitlement): void {
  if (getCachedEntitlement().status === 'activated' && next.status !== 'activated') {
    return;
  }
  set(ENTITLEMENT_KEY, JSON.stringify({ status: next.status, source: next.source ?? null }));
}

/**
 * Sign out: drop the session and EVERYTHING derived from it, the display mode included.
 *
 * THE DISPLAY MODE IS AN ACCOUNT PROPERTY, NOT A DEVICE ONE. Server truth lives in
 * users.displayMode and arrives at sign-in (setSession writes it from the response). A
 * signed-out device has no account, so it has no display mode to honour — and a stored
 * one is worse than useless: it would decide what a stranger, a new visitor arriving from
 * the public site, or a second person on a shared device sees, none of whom that
 * preference belongs to.
 *
 * An earlier revision kept `covert` across sign-out so a survivor's disguise survived it.
 * That was reversed deliberately: it meant a signed-out visitor could be shown the
 * meditation facade with no obvious way into the product. The mode is cleared here so it
 * CANNOT be read without a session, which makes the rule structural rather than something
 * every future caller has to remember to check.
 *
 * The consequence is accepted and real: a survivor who signs out gets the branded landing
 * on reopen until they sign back in, at which point their Hidden skin is restored from
 * the account.
 */
export function clearSession(): void {
  del(TOKEN_KEY);
  del(MODE_KEY);
  del(USER_KEY);
  del(SETUP_KEY);
  del(ENTITLEMENT_KEY);
  del(CONSOLE_KEY);
}

/**
 * The account's console level, cached from the last live /v1/console/me — the same
 * pattern as the entitlement cache, and for the same reason: the ROOT route must decide
 * what to render SYNCHRONOUSLY.
 *
 * WHY THIS EXISTS AT ALL. `/` sends a signed-in Visible user straight to their armed
 * screen. Making that decision wait on a network round-trip would put a spinner between
 * a survivor and the screen with the trigger on it — offline, it would never resolve.
 * So the landing reads this hint instead, and the hint is refreshed by every surface
 * that already calls /v1/console/me (Settings, the console itself).
 *
 * IT IS A HINT, NEVER AN AUTHORITY. It decides which SCREEN is shown and nothing more:
 * every console route re-derives the level server-side from the session and refuses on
 * its own, so a tampered value buys a link to a page that will 403. It defaults to
 * "no level", so the failure direction is a survivor going straight into their app —
 * which is the right place for them to be.
 */
export function cacheConsoleLevel(label: string | null): void {
  if (label) {
    set(CONSOLE_KEY, label);
  } else {
    del(CONSOLE_KEY);
  }
}

/** The cached console level label (DEV/ADMIN/COORD), or null for "no level known". */
export function getCachedConsoleLevel(): string | null {
  const v = get(CONSOLE_KEY);
  return v === 'DEV' || v === 'ADMIN' || v === 'COORD' ? v : null;
}
