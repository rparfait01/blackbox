/**
 * Sign-up + sign-in (Brief 14: email removed from the critical path).
 *
 * Accounts authenticate by PASSWORD, not an emailed code. Signing up creates the
 * account immediately and never depends on an outbound email succeeding; the
 * email is stored unverified and verification (if ever added back) is an optional,
 * non-blocking step. Signing in checks the password — with a fallback to the
 * existing closure-pin hash for legacy accounts that predate passwords — so no
 * email or SMS provider is in the signup/login path for the pilot.
 *
 * On success the user receives an HMAC session token (no expiry in v0).
 */

import { Hono } from 'hono';
import { sessionSecret } from '../auth';
import { hashSecret } from '../lib/crypto';
import { mintSession } from '../lib/session';
import { createResetToken, consumeResetToken } from '../lib/password-reset';
import {
  claimByUserHash,
  createDraftUser,
  finalizeUser,
  getUserByEmail,
  getUserById,
  isActive,
  normalizeEmail,
  verifyLoginCredential,
} from '../lib/users';
import type { Env, Vars } from '../types';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function isPin(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{3,6}$/.test(value);
}

function isPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 6;
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
  if (!isPassword(body.password)) {
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  }
  const result = await createDraftUser(c.env, {
    name: body.name,
    phone: body.phone ?? '',
    email: body.email,
    regionId: body.regionId ?? 'jp',
    nationality: body.nationality?.trim() ? body.nationality.trim() : null,
    passwordHash: await hashSecret(body.password),
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
      lockCode?: string;
      duressCode?: string;
      claimUserHash?: string;
    }>()
    .catch(() => ({}) as Record<string, string>);
  if (body.displayMode !== 'direct' && body.displayMode !== 'covert') {
    return c.json({ error: 'displayMode must be direct or covert' }, 400);
  }
  // Brief 9: the closure pin is now 3-digit and on-device only. The server pin
  // hash is vestigial (closure is coordinator-secured), so accept a 3–6 digit
  // lockCode and store it harmlessly. Duress is no longer a separate code.
  if (!body.signupId || !isPin(body.lockCode)) {
    return c.json({ error: 'signupId and a 3-6 digit lockCode are required' }, 400);
  }
  if (body.duressCode !== undefined && !isPin(body.duressCode)) {
    return c.json({ error: 'duressCode must be 3-6 digits' }, 400);
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
  await finalizeUser(c.env, user.id, {
    displayMode: body.displayMode,
    lockCodeHash: await hashSecret(body.lockCode),
    duressCodeHash: body.duressCode ? await hashSecret(body.duressCode) : null,
  });
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

// --- Forgot password (Brief 15 §D) ---
// Issue a single-use, expiring reset link to the account email. Always returns
// 200 with no hint about whether the account exists (no enumeration here, unlike
// the deliberate signin UX choice), and the email send is fire-and-forget so the
// response timing carries no signal either.
authRoutes.post('/forgot', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = (body.email ?? '').trim();
  if (email) {
    const token = await createResetToken(c.env, normalizeEmail(email));
    if (token && c.env.PWA_ORIGIN) {
      const link = `${c.env.PWA_ORIGIN}/reset?token=${token}`;
      const { sendEmail } = await import('../channels/sendgrid-email');
      c.executionCtx.waitUntil(
        sendEmail(
          c.env,
          {
            to: email,
            subject: 'Reset your BLACK BOX password',
            html: `<p>We received a request to reset your password. This link is valid for one hour and can be used once:</p><p><a href="${link}">${link}</a></p><p>If you didn’t request this, you can ignore this email — nothing has changed.</p>`,
            text: `Reset your BLACK BOX password (valid 1 hour, single use): ${link}\n\nIf you didn’t request this, ignore this email.`,
          },
          'password_reset',
        ),
      );
    }
  }
  return c.json({ ok: true }, 200);
});

// Redeem a reset token: set the new password and invalidate all prior sessions.
authRoutes.post('/reset', async (c) => {
  const body = await c.req
    .json<{ token?: string; password?: string }>()
    .catch(() => ({}) as { token?: string; password?: string });
  const token = (body.token ?? '').trim();
  if (!token || !isPassword(body.password)) {
    return c.json({ error: 'token and a password of at least 6 characters are required' }, 400);
  }
  const ok = await consumeResetToken(c.env, token, body.password);
  if (!ok) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  return c.json({ ok: true }, 200);
});
