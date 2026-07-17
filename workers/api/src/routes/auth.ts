/**
 * Sign-up + sign-in — PASSWORDLESS (Accounts §1).
 *
 * Identity only. No payment, no billing, no org model (Tenancy owns those).
 *
 * The credential ladder, in the order the app offers it:
 *
 *   1. PASSKEY (primary). Nothing to remember, nothing written down, nothing an
 *      abuser can find or phish out of an inbox. Lives in the device keychain and
 *      restores itself on a new device via iCloud/Google.
 *   2. MAGIC LINK (fallback ONLY while the account has no passkey). For devices
 *      that cannot do WebAuthn, and the migration path for pilot accounts. REFUSED
 *      once a passkey exists — see lib/account-magic-link.ts for why that gate is
 *      the whole point rather than a nicety.
 *   3. RECOVERY CODE (backup). Shown once at setup, never emailed — the path that
 *      survives a monitored inbox.
 *
 * There is NO password-reset-by-email path: §2 forbids it (the abuser may read the
 * inbox), and /forgot + /reset were deleted with this brief.
 *
 * POST /signin (password) is RETAINED server-side but is no longer reachable from
 * any UI. It is the pilot's safety net during migration — deleting it in the same
 * commit that removes the password field would strand any pilot user whose magic
 * link failed to arrive. It goes in a follow-up once the pilot has migrated.
 *
 * Every path mints the SAME session token shape (lib/session.ts). The token is
 * never extended to record how you authenticated — a new claim changes the signed
 * string and would invalidate every live pilot session.
 */

import { Hono } from 'hono';
import { sessionSecret } from '../auth';
import { hashSecret } from '../lib/crypto';
import { mintSession } from '../lib/session';
import { audit } from '../lib/audit';
import {
  authenticationOptions,
  pruneChallenges,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../lib/passkey';
import { createMagicLink, consumeMagicLink } from '../lib/account-magic-link';
import { consumeRecoveryCode, issueRecoveryCodes } from '../lib/recovery-code';
import {
  claimByUserHash,
  createDraftUser,
  finalizeUser,
  getUserByEmail,
  getUserById,
  hasActiveEvent,
  isActive,
  normalizeEmail,
  verifyLoginCredential,
} from '../lib/users';
import { verifySession } from '../lib/session';
import type { Env, Vars } from '../types';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function isPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 6;
}

/** Resolve the caller's userId from a Bearer session, or null. */
async function bearerUserId(c: { env: Env; req: { header: (n: string) => string | undefined } }): Promise<string | null> {
  const secret = sessionSecret(c.env);
  const token = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !token) return null;
  const session = await verifySession(secret, token);
  return session?.userId ?? null;
}

/**
 * §5 + Brief 20: account MUTATIONS are locked during a live alert — enrolling a
 * credential or re-minting recovery codes mid-event is exactly the kind of account
 * change the lock exists to refuse (and, under coercion, exactly what an aggressor
 * holding the phone would do).
 *
 * Deliberately NOT applied to any LOGIN path (passkey/login, magic/consume,
 * recovery/consume). A survivor whose alert is live may be on a borrowed or
 * replacement device and must still be able to sign in and reach their own alert.
 * Locking sign-in mid-crisis would be the dead-button failure wearing a different
 * hat. The lock refuses CHANGES to the account, never ACCESS to it.
 *
 * Follows the codebase's opt-in per-route pattern (user.ts lockedDuringAlert), not
 * middleware — so a new route is never silently locked or silently not.
 */
async function lockedDuringAlert(env: Env, userId: string): Promise<boolean> {
  return hasActiveEvent(env, userId);
}

// --- Sign-up ---
// One non-blocking step: create the account with a password and return its id.
// NO email is sent and NO email delivery can fail here (Brief 14 P0).

authRoutes.post('/signup/start', async (c) => {
  const body = await c.req
    .json<{
      name?: string;
      phone?: string;
      email?: string;
      password?: string;
      regionId?: string;
      nationality?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.name || !body.email) {
    return c.json({ error: 'name and email are required' }, 400);
  }
  // PASSWORDLESS (§1): no password is required or requested. The field is accepted
  // only so an older client build mid-rollout still signs up successfully; new
  // accounts are created with passwordHash NULL and authenticate by passkey. A
  // NULL passwordHash can never satisfy verifyLoginCredential (users.ts), so a
  // passwordless account is not sign-in-able by password — which is the intent.
  const result = await createDraftUser(c.env, {
    name: body.name,
    phone: body.phone ?? '',
    email: body.email,
    regionId: body.regionId ?? 'jp',
    nationality: body.nationality?.trim() ? body.nationality.trim() : null,
    passwordHash: isPassword(body.password) ? await hashSecret(body.password) : null,
  });
  if (!result.ok || !result.userId) {
    return c.json({ error: result.reason ?? 'signup_failed' }, 409);
  }
  return c.json({ signupId: result.userId }, 201);
});

authRoutes.post('/signup/finalize', async (c) => {
  const body = await c.req
    .json<{
      signupId?: string;
      displayMode?: string;
      claimUserHash?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);
  if (body.displayMode !== 'direct' && body.displayMode !== 'covert') {
    return c.json({ error: 'displayMode must be direct or covert' }, 400);
  }
  // Brief 16 §1: NO lock code. Closure is gesture-only end to end — the finalize
  // contract no longer accepts or requires a pin/lockCode of any kind.
  if (!body.signupId) {
    return c.json({ error: 'signupId is required' }, 400);
  }
  const user = await getUserById(c.env, body.signupId);
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  // No email-verified gate (Brief 14): the account works without any email step.
  const secret = sessionSecret(c.env);
  if (!secret) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  await finalizeUser(c.env, user.id, { displayMode: body.displayMode });
  if (body.claimUserHash) {
    await claimByUserHash(c.env, user.id, body.claimUserHash);
  }
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: body.displayMode }, 200);
});

// --- Sign-in ---
// Email + password, no emailed code (Brief 14 P0). Legacy accounts without a
// password fall back to their closure-pin hash inside verifyLoginCredential.

authRoutes.post('/signin', async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400);
  }
  const email = normalizeEmail(body.email);
  const user = await getUserByEmail(c.env, email);
  // The pilot UX favors a clear "no account found" over enumeration resistance.
  if (!user || !isActive(user)) {
    return c.json({ error: 'user_not_found' }, 404);
  }
  if (!(await verifyLoginCredential(user, body.password))) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const secret = sessionSecret(c.env);
  if (!secret) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: user.displayMode }, 200);
});

// --- PASSKEY (§1: primary credential) ---

/**
 * Registration options. Authenticated by EITHER a live session (enrolling another
 * device / re-enrolling from Settings) or a signupId (enrolling during onboarding,
 * before finalize has minted a session). The signupId path is safe because a draft
 * user id is a UUID that only this client has just been handed.
 */
authRoutes.post('/passkey/register/options', async (c) => {
  const body = await c.req.json<{ signupId?: string }>().catch(() => ({}) as { signupId?: string });
  const sessionUserId = await bearerUserId(c);
  const userId = sessionUserId ?? body.signupId ?? null;
  if (!userId) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const user = await getUserById(c.env, userId);
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  // userName/userDisplayName are only the label the OS shows in the passkey picker.
  // Fall back rather than fail: an account with no email/name on file must still be
  // able to enroll a credential.
  const options = await registrationOptions(c.env, {
    id: user.id,
    email: user.email ?? user.id,
    name: user.name ?? 'BLACK BOX',
  });
  if (!options) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  c.executionCtx.waitUntil(pruneChallenges(c.env));
  return c.json(options, 200);
});

/** Verify enrollment and persist the passkey. */
authRoutes.post('/passkey/register/verify', async (c) => {
  const body = await c.req
    .json<{ signupId?: string; response?: RegistrationResponseJSON; deviceLabel?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const sessionUserId = await bearerUserId(c);
  const userId = sessionUserId ?? body.signupId ?? null;
  if (!userId || !body.response) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Enrolling a credential is an account change — refused while an alert is live.
  if (await lockedDuringAlert(c.env, userId)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const ok = await verifyRegistration(c.env, userId, body.response, body.deviceLabel?.slice(0, 60) ?? null);
  if (!ok) {
    return c.json({ error: 'registration_failed' }, 400);
  }
  await audit(c.env, null, 'auth.passkey_registered', userId, {});
  return c.json({ ok: true }, 200);
});

/**
 * Login options. Usernameless — no email is typed, and the request carries no
 * identifier, so this endpoint leaks nothing about who has an account.
 */
authRoutes.post('/passkey/login/options', async (c) => {
  const options = await authenticationOptions(c.env);
  if (!options) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  return c.json(options, 200);
});

/** Verify a passkey login → session. */
authRoutes.post('/passkey/login/verify', async (c) => {
  const body = await c.req
    .json<{ response?: AuthenticationResponseJSON }>()
    .catch(() => ({}) as Record<string, never>);
  if (!body.response) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const userId = await verifyAuthentication(c.env, body.response);
  if (!userId) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const user = await getUserById(c.env, userId);
  const secret = sessionSecret(c.env);
  if (!user || !isActive(user) || !secret) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  await audit(c.env, null, 'auth.passkey_login', userId, {});
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: user.displayMode }, 200);
});

// --- MAGIC LINK (§1b: fallback ONLY while no passkey exists) ---

/**
 * Request a login link. ALWAYS 200, regardless of whether the account exists or
 * whether it was refused for holding a passkey — the response must not tell a
 * prober which emails are enrolled, nor which accounts are passkey-protected
 * (that would be a map of which survivors are reachable by inbox).
 */
authRoutes.post('/magic/start', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const raw = (body.email ?? '').trim();
  if (raw) {
    const result = await createMagicLink(c.env, normalizeEmail(raw));
    if ('token' in result && c.env.PWA_ORIGIN) {
      const link = `${c.env.PWA_ORIGIN}/magic?token=${result.token}`;
      const { sendEmail } = await import('../channels/sendgrid-email');
      c.executionCtx.waitUntil(
        sendEmail(
          c.env,
          {
            to: raw,
            subject: 'Your BLACK BOX sign-in link',
            html: `<p>Tap to sign in. This link works once and expires in 15 minutes:</p><p><a href="${link}">${link}</a></p><p>If you didn’t ask to sign in, ignore this email — nothing has changed.</p>`,
            text: `Sign in to BLACK BOX (works once, expires in 15 minutes): ${link}\n\nIf you didn’t ask to sign in, ignore this email.`,
          },
          'account_magic_link',
        ),
      );
    } else if ('refused' in result && result.refused === 'has_passkey') {
      // Not an error — the gate working. Audited so a burst of these against one
      // account is visible as what it is: someone with inbox access trying to get in.
      await audit(c.env, null, 'auth.magic_link_refused_has_passkey', null, {});
    }
  }
  return c.json({ ok: true }, 200);
});

/** Redeem a login link → session. */
authRoutes.post('/magic/consume', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  const token = (body.token ?? '').trim();
  if (!token) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  const userId = await consumeMagicLink(c.env, token);
  if (!userId) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  const user = await getUserById(c.env, userId);
  const secret = sessionSecret(c.env);
  if (!user || !isActive(user) || !secret) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  await audit(c.env, null, 'auth.magic_link_login', userId, {});
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: user.displayMode }, 200);
});

// --- RECOVERY CODE (§2: discreet backup, never emailed) ---

/** Mint (or re-mint) recovery codes for the signed-in / just-signed-up account. */
authRoutes.post('/recovery/issue', async (c) => {
  const body = await c.req.json<{ signupId?: string }>().catch(() => ({}) as { signupId?: string });
  const sessionUserId = await bearerUserId(c);
  const userId = sessionUserId ?? body.signupId ?? null;
  if (!userId) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const user = await getUserById(c.env, userId);
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  // Re-minting recovery codes invalidates the old set — an account change, and one
  // an aggressor holding the phone mid-event would love. Refused while live.
  if (await lockedDuringAlert(c.env, userId)) {
    return c.json({ error: 'locked_during_active_alert' }, 423);
  }
  const codes = await issueRecoveryCodes(c.env, userId);
  await audit(c.env, null, 'auth.recovery_codes_issued', userId, {});
  return c.json({ codes }, 200);
});

/**
 * Redeem a recovery code → session. Scoped by email so a guess is bounded to one
 * account rather than sprayed across every account at once.
 */
authRoutes.post('/recovery/consume', async (c) => {
  const body = await c.req
    .json<{ email?: string; code?: string }>()
    .catch(() => ({}) as { email?: string; code?: string });
  if (!body.email || !body.code) {
    return c.json({ error: 'invalid_recovery_code' }, 400);
  }
  const user = await getUserByEmail(c.env, normalizeEmail(body.email));
  // One flat answer for "no such account" and "wrong code" — never confirm that an
  // address is enrolled to someone probing with a junk code.
  if (!user || !isActive(user) || !(await consumeRecoveryCode(c.env, user.id, body.code))) {
    return c.json({ error: 'invalid_recovery_code' }, 400);
  }
  const secret = sessionSecret(c.env);
  if (!secret) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  await audit(c.env, null, 'auth.recovery_code_login', user.id, {});
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: user.displayMode }, 200);
});
