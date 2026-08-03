import type { Env } from '../types';

/**
 * Brief 33 Fix B §A/§B — THE COORDINATOR VIEW SESSION.
 *
 * ═══ §0 OUTRANKS THIS ENTIRE FILE ════════════════════════════════════════════════════════════
 *
 * A coordinator responding to a live alert must not encounter one additional step, prompt, or
 * decision. Not a login, not a confirmation. They tap the link and they are looking at the event,
 * possibly at 3am, possibly on a phone they barely use.
 *
 * Every function here is written to that constraint. The exchange is an HTTP redirect the browser
 * performs by itself; there is no interstitial, no button, and no JavaScript requirement for the
 * part that removes the token from the address bar.
 *
 * ═══ EVERY FAILURE MODE RESOLVES TOWARD "THE COORDINATOR GETS IN" ════════════════════════════
 *
 * This sits on the alert path, so it fails open, and §B enumerates exactly who a strict
 * implementation would lock out — each one a person who cannot help:
 *
 *   the SMS client prefetches the link   → a prefetch cannot redeem (it makes no POST), so the
 *                                          token stays unbound and the human's tap still works
 *   they tap twice / the page reloads    → same browser, same session — succeeds
 *   phone first, then laptop             → the second browser is refused ONLY if a human already
 *                                          redeemed on the first; otherwise it just works
 *   cookies blocked or cleared           → no session can be created, so the token is never
 *                                          bound and the tokened URL keeps working as it does
 *                                          today. Degraded privacy, working access.
 *   the store is unreachable             → treated as "not bound", never as "refused"
 *
 * A coordinator wrongly refused is worse than a token wrongly honoured. That is the standing rule
 * for this path and it decides every branch below.
 *
 * ═══ THE PREFETCH MECHANISM, NAMED (§B) ══════════════════════════════════════════════════════
 *
 * Binding happens on `POST /v1/c/:id/redeem`, issued by the loaded dashboard page. Link scanners,
 * SMS previewers and mail-security bots issue GETs and do not execute page script, so they never
 * produce the signal. Its failure mode, stated rather than discovered: a coordinator with
 * JavaScript disabled never binds the token either — so the token stays unbound and usable from
 * any browser. That is strictly the current behaviour, minus the address bar, and it is the
 * direction this path is required to fail in.
 */

/** How long a view session stays valid without being seen. Generous by design — see §E5. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const VIEW_COOKIE = 'bbview';

/**
 * Cookie attributes.
 *
 * §E2 — Brief 42 §D verified `HttpOnly`, `Secure` and `SameSite` on `bbcoord`, and redemption
 * must not weaken any of them to make the redirect work.
 *
 * `SameSite: 'Lax'` and not 'Strict': the coordinator arrives by tapping a link in an SMS or mail
 * client, which is a cross-site top-level navigation. Under 'Strict' the cookie is not sent on
 * that navigation, the bare URL would fail to authenticate, and the coordinator would be staring
 * at an error instead of the event. 'Lax' sends it on exactly this case and withholds it from
 * cross-site subrequests, which is the property that matters here.
 */
export const VIEW_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ViewSession {
  sessionKey: string;
  eventId: string;
  tokenHash: string;
  role: string;
  redeemedAt: number | null;
}

/**
 * Mint a view session for a verified token. Returns null when the store is unavailable, and the
 * caller then serves the tokened page exactly as before — a failed session is never a refusal.
 */
export async function createViewSession(
  env: Env,
  input: { eventId: string; token: string; role: string },
): Promise<string | null> {
  try {
    const sessionKey = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(
      'INSERT INTO coordinator_view_sessions (sessionKey, eventId, tokenHash, role, redeemedAt, createdAt, lastSeenAt) ' +
        'VALUES (?, ?, ?, ?, NULL, ?, ?)',
    )
      .bind(sessionKey, input.eventId, await hashToken(input.token), input.role, Date.now(), Date.now())
      .run();
    return sessionKey;
  } catch {
    return null;
  }
}

/** Resolve a presented cookie to a live session for this event. Never throws. */
export async function getViewSession(env: Env, sessionKey: string, eventId: string): Promise<ViewSession | null> {
  if (!sessionKey) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT sessionKey, eventId, tokenHash, role, redeemedAt, createdAt FROM coordinator_view_sessions ' +
        'WHERE sessionKey = ? AND eventId = ?',
    )
      .bind(sessionKey, eventId)
      .first<ViewSession & { createdAt: number }>();
    if (!row) return null;
    if (Date.now() - row.createdAt > SESSION_TTL_MS) return null;
    return row;
  } catch {
    // §B fail-open: an unreachable store must not turn a valid coordinator away. The caller
    // falls back to the tokened path, which still works.
    return null;
  }
}

export type TokenDisposition =
  /** Nobody has redeemed this link yet — anyone holding it may proceed. */
  | { state: 'unbound' }
  /** This browser redeemed it. The ordinary repeat visit, and it succeeds. */
  | { state: 'bound_to_self' }
  /** A human redeemed it in a DIFFERENT browser. The only case that is refused. */
  | { state: 'bound_elsewhere'; redeemedAt: number };

/**
 * Has a human already bound this link, and to whom?
 *
 * §B: "Only a different browser presenting a spent token is refused." Note what is NOT consulted
 * — whether a session exists, whether the link was fetched, how many times. Only whether a HUMAN
 * redeemed, which is the one signal a scanner cannot produce.
 */
export async function tokenDisposition(
  env: Env,
  input: { eventId: string; token: string; presentedSessionKey: string | null },
): Promise<TokenDisposition> {
  try {
    const tokenHash = await hashToken(input.token);
    const redeemed = await env.DB.prepare(
      'SELECT sessionKey, redeemedAt FROM coordinator_view_sessions ' +
        'WHERE tokenHash = ? AND eventId = ? AND redeemedAt IS NOT NULL ORDER BY redeemedAt LIMIT 1',
    )
      .bind(tokenHash, input.eventId)
      .first<{ sessionKey: string; redeemedAt: number }>();
    if (!redeemed) return { state: 'unbound' };
    if (input.presentedSessionKey && redeemed.sessionKey === input.presentedSessionKey) {
      return { state: 'bound_to_self' };
    }
    return { state: 'bound_elsewhere', redeemedAt: redeemed.redeemedAt };
  } catch {
    // Unreachable store → treat as unbound. Refusing here would lock out a coordinator because
    // of OUR outage, on the one path where that is the worst possible outcome.
    return { state: 'unbound' };
  }
}

/**
 * Bind the link to this browser. Called only from the explicit redeem POST.
 *
 * Idempotent, and deliberately a no-op when another session already redeemed: two coordinators
 * may hold the same link (§E4), and the cascade sends to several contacts by design. The first
 * human to redeem binds it; a second arriving later is handled by the self-service path rather
 * than by silently stealing the binding.
 */
export async function redeemViewSession(env: Env, sessionKey: string, eventId: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      'UPDATE coordinator_view_sessions SET redeemedAt = COALESCE(redeemedAt, ?), lastSeenAt = ? ' +
        'WHERE sessionKey = ? AND eventId = ?',
    )
      .bind(Date.now(), Date.now(), sessionKey, eventId)
      .run();
    return true;
  } catch {
    return false;
  }
}

/** §C — how many live events still carry links minted before this brief. Reporting only. */
export async function outstandingLegacyLinkCount(env: Env): Promise<{ liveEvents: number; withViewSession: number }> {
  try {
    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status = 'active'").first<{ n: number }>();
    const withSession = await env.DB.prepare(
      "SELECT COUNT(DISTINCT eventId) AS n FROM coordinator_view_sessions WHERE eventId IN (SELECT id FROM events WHERE status = 'active')",
    ).first<{ n: number }>();
    return { liveEvents: Number(live?.n ?? 0), withViewSession: Number(withSession?.n ?? 0) };
  } catch {
    return { liveEvents: -1, withViewSession: -1 };
  }
}
