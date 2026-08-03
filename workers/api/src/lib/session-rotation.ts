/**
 * Brief 42 §C — ROTATE THE SESSION AT EVERY PRIVILEGE TRANSITION.
 *
 * An identifier captured before authentication, or before a role change, stayed valid after it.
 * Rotation replaces the presented token at the moment privilege changes, so a token lifted from a
 * log, a screenshot or a shared device does not carry the new privilege with it.
 *
 * ═══ WHAT IS INVALIDATED, AND WHAT IS DELIBERATELY NOT ════════════════════════════════════════
 *
 * The PRESENTED token, and nothing else. There is an existing per-user epoch
 * (`users.sessionsValidFrom`) used by password reset, and reaching for it here would have been
 * easy and wrong: it invalidates every session the account holds on every device. A survivor
 * signed out by a housekeeping change is a survivor who cannot trigger until she remembers a
 * credential, and a role change is housekeeping. Her second device keeps working because it was
 * never the identifier being replaced.
 *
 * ═══ §C — TWO FORMATS, AND ROTATION IS THE MIGRATION PATH ═════════════════════════════════════
 *
 * Brief 2 Fix A replaced `<userId>.<issuedAt>.<hmac>` with `bbxs1.<AES-GCM(...)>.<hmac>`, and
 * legacy tokens verify indefinitely because sessions never expire. Rotation accepts EITHER format
 * as input and always emits `bbxs1.` — a privilege transition is the natural moment to upgrade a
 * token without an expiry event, so the old format drains as accounts touch privilege rather than
 * by a flag date that would sign everyone out at once. Nobody re-authenticates to migrate.
 *
 * ═══ §E5 — THIS SITS NEAR THE TRIGGER PATH, SO IT FAILS OPEN ══════════════════════════════════
 *
 * A rotation bug that invalidates a valid session is a survivor who cannot trigger. Every failure
 * mode here resolves toward the session continuing to work:
 *
 *   revocation store unreachable   → the token is treated as VALID
 *   revocation write fails         → the new token is still issued and returned
 *   mint fails                     → the caller keeps the token it had
 *
 * The trigger path itself is untouched. `POST /v1/events` resolves a session only to attribute
 * the event and never gates on it, so even a genuinely revoked token opens an event — as a
 * tokenless one. That is stated rather than incidental: on the alert path, availability outranks
 * attribution, and a revoked token can do nothing else, because every other route gates through
 * `requireSession`.
 */
import { mintSession } from './session';
import type { Env } from '../types';

export type SessionFormat = 'legacy' | 'bbxs1';

/** Which format a presented token is. Cheap, and never throws on a malformed value. */
export function sessionFormat(token: string | null | undefined): SessionFormat | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  return parts[0] === 'bbxs1' ? 'bbxs1' : 'legacy';
}

/** The revocation key. The token is never stored — only this. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Revoke exactly one token.
 *
 * Idempotent: rotating twice with the same presented token is not an error, it is a retry.
 */
export async function revokeToken(env: Env, token: string, userId: string, reason: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO revoked_sessions (tokenHash, userId, revokedAt, reason) VALUES (?, ?, ?, ?)',
    )
      .bind(await tokenHash(token), userId, Date.now(), reason.slice(0, 60))
      .run();
    return true;
  } catch {
    // §E5 — a failed revocation must not fail the transition it accompanies. The new token is
    // still issued; the old one outliving it is a smaller harm than a blocked privilege change.
    return false;
  }
}

/**
 * Rotate: mint a fresh `bbxs1.` token and revoke the one that was presented.
 *
 * Returns the new token, or null if minting was impossible — in which case the caller keeps the
 * token it had rather than being left with none.
 */
export async function rotateSession(
  env: Env,
  input: { userId: string; presentedToken?: string | null; reason: string },
): Promise<{ token: string; rotated: boolean; previousFormat: SessionFormat | null } | null> {
  const secret = (env.SESSION_SECRET ?? '').trim();
  if (!secret) return null;
  const previousFormat = sessionFormat(input.presentedToken);
  let token: string;
  try {
    token = await mintSession(secret, input.userId);
  } catch {
    return null;
  }
  let rotated = false;
  if (input.presentedToken && input.presentedToken !== token) {
    rotated = await revokeToken(env, input.presentedToken, input.userId, input.reason);
  }
  return { token, rotated, previousFormat };
}

/**
 * §C — the legacy share, recorded only when it CHANGES.
 *
 * Sessions are stateless and cannot be enumerated, so this stores the format each account last
 * presented. For a given account it is written once — on the rotation that upgrades it — so the
 * ordinary request path pays nothing. It is a signal about retirement readiness, not a census, and
 * the readiness panel says so.
 */
export async function noteSessionFormat(env: Env, userId: string, format: SessionFormat, previous: string | null): Promise<void> {
  if (previous === format) return;
  try {
    await env.DB.prepare('UPDATE users SET lastSessionFormat = ? WHERE id = ?').bind(format, userId).run();
  } catch {
    /* a missed observation is a slightly stale panel, never a failed request */
  }
}

/** §C — what the readiness panel reports about format retirement. */
export async function sessionFormatShare(env: Env) {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS accounts,
         (SELECT COUNT(*) FROM users WHERE lastSessionFormat = 'bbxs1') AS upgraded,
         (SELECT COUNT(*) FROM users WHERE lastSessionFormat = 'legacy') AS legacy,
         (SELECT COUNT(*) FROM revoked_sessions) AS revoked`,
    ).first<{ accounts: number; upgraded: number; legacy: number; revoked: number }>();
    const accounts = Number(row?.accounts ?? 0);
    const upgraded = Number(row?.upgraded ?? 0);
    const legacy = Number(row?.legacy ?? 0);
    return {
      accounts,
      lastPresentedBbxs1: upgraded,
      lastPresentedLegacy: legacy,
      unobserved: accounts - upgraded - legacy,
      revokedTokens: Number(row?.revoked ?? 0),
      summary:
        `SESSION FORMAT: ${upgraded} account(s) last presented bbxs1, ${legacy} legacy, ` +
        `${accounts - upgraded - legacy} not yet observed · ${Number(row?.revoked ?? 0)} token(s) revoked · ` +
        'observed on use, not a census — an account that has not signed in since the change is simply unobserved',
    };
  } catch {
    return { configured: false, summary: 'SESSION FORMAT: NOT MEASURED' };
  }
}
