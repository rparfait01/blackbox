/**
 * Sign-up + sign-in (W8A). Email-OTP only (SMS deferred). Sign-up is a 3-step
 * draft → email-verified → finalized progression; sign-in is OTP to a known
 * email. On success the user receives an HMAC session token (no expiry in v0).
 */

import { Hono } from 'hono';
import { sessionSecret } from '../auth';
import { hashSecret } from '../lib/crypto';
import { generateOtp, sendOtpViaEmail, storeOtp, verifyOtp } from '../lib/otp';
import { mintSession } from '../lib/session';
import {
  claimByUserHash,
  createDraftUser,
  finalizeUser,
  getUserByEmail,
  getUserById,
  isActive,
  markEmailVerified,
  normalizeEmail,
} from '../lib/users';
import type { Env, Vars } from '../types';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function isFourDigits(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}$/.test(value);
}

// --- Sign-up ---

authRoutes.post('/signup/start', async (c) => {
  const body = await c.req
    .json<{ name?: string; phone?: string; email?: string; regionId?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.name || !body.email) {
    return c.json({ error: 'name and email are required' }, 400);
  }
  const result = await createDraftUser(c.env, {
    name: body.name,
    phone: body.phone ?? '',
    email: body.email,
    regionId: body.regionId ?? 'jp',
  });
  if (!result.ok || !result.userId) {
    return c.json({ error: result.reason ?? 'signup_failed' }, 409);
  }
  const email = normalizeEmail(body.email);
  const code = generateOtp();
  const stored = await storeOtp(c.env, email, code, 'email');
  if (!stored.ok) {
    return c.json({ error: stored.reason ?? 'otp_failed' }, 429);
  }
  // Await the send: do NOT return 201 unless SendGrid accepted the message.
  const sent = await sendOtpViaEmail(c.env, email, code);
  if (!sent.ok) {
    return c.json(
      { error: 'email_send_failed', sendgridStatus: sent.status, sendgridBody: sent.body },
      502,
    );
  }
  return c.json({ signupId: result.userId, expiresAt: stored.expiresAt }, 201);
});

authRoutes.post('/signup/verify-email', async (c) => {
  const body = await c.req
    .json<{ signupId?: string; code?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.signupId || !body.code) {
    return c.json({ error: 'signupId and code are required' }, 400);
  }
  const user = await getUserById(c.env, body.signupId);
  if (!user?.email) {
    return c.json({ error: 'not found' }, 404);
  }
  const result = await verifyOtp(c.env, user.email, body.code);
  if (!result.ok) {
    return c.json({ error: result.reason ?? 'invalid' }, 400);
  }
  await markEmailVerified(c.env, user.id);
  return c.json({ ok: true }, 200);
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
  if (!body.signupId || !isFourDigits(body.lockCode)) {
    return c.json({ error: 'signupId and a 4-digit lockCode are required' }, 400);
  }
  if (body.duressCode !== undefined && !isFourDigits(body.duressCode)) {
    return c.json({ error: 'duressCode must be 4 digits' }, 400);
  }
  const user = await getUserById(c.env, body.signupId);
  if (!user) {
    return c.json({ error: 'not found' }, 404);
  }
  if (!user.emailVerifiedAt) {
    return c.json({ error: 'email_not_verified' }, 403);
  }
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

authRoutes.post('/signin/start', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as Record<string, string>);
  if (!body.email) {
    return c.json({ error: 'email is required' }, 400);
  }
  const email = normalizeEmail(body.email);
  const user = await getUserByEmail(c.env, email);
  // The pilot UX favors a clear "no account found" over enumeration resistance,
  // so an unknown / unfinalized email returns 404.
  if (!user || !isActive(user)) {
    return c.json({ error: 'user_not_found' }, 404);
  }
  const code = generateOtp();
  const stored = await storeOtp(c.env, email, code, 'email');
  if (!stored.ok) {
    return c.json({ error: stored.reason ?? 'otp_failed' }, 429);
  }
  const sent = await sendOtpViaEmail(c.env, email, code);
  if (!sent.ok) {
    return c.json(
      { error: 'email_send_failed', sendgridStatus: sent.status, sendgridBody: sent.body },
      502,
    );
  }
  return c.json({ ok: true, expiresAt: stored.expiresAt }, 200);
});

authRoutes.post('/signin/verify', async (c) => {
  const body = await c.req
    .json<{ email?: string; code?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.email || !body.code) {
    return c.json({ error: 'email and code are required' }, 400);
  }
  const email = normalizeEmail(body.email);
  const result = await verifyOtp(c.env, email, body.code);
  if (!result.ok) {
    return c.json({ error: result.reason ?? 'invalid' }, 400);
  }
  const user = await getUserByEmail(c.env, email);
  const secret = sessionSecret(c.env);
  if (!user || !isActive(user) || !secret) {
    return c.json({ error: 'invalid' }, 400);
  }
  const sessionToken = await mintSession(secret, user.id);
  return c.json({ userId: user.id, sessionToken, displayMode: user.displayMode }, 200);
});
