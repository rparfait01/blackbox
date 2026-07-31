/**
 * One-time-passcode service (W8A). 6-digit numeric codes, 10-minute TTL, stored
 * hashed (PBKDF2). Verification enforces a 5-attempt limit per code; issuance is
 * rate-limited to 5 codes per identifier per hour. v0 delivers only by email
 * (SendGrid); the SMS path is a documented stub.
 */

import type { Env } from '../types';
import { hashSecret, verifySecret } from './crypto';
import { sendEmail, type SendResult } from '../channels/sendgrid-email';

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;

export function generateOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return String(n % 1_000_000).padStart(6, '0');
}

export interface StoreResult {
  ok: boolean;
  expiresAt?: number;
  reason?: 'rate_limited';
}

export async function storeOtp(
  env: Env,
  identifier: string,
  code: string,
  channel = 'email',
): Promise<StoreResult> {
  const now = Date.now();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM otp_codes WHERE identifier = ? AND createdAt > ?',
  )
    .bind(identifier, now - RATE_WINDOW_MS)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= RATE_MAX) {
    return { ok: false, reason: 'rate_limited' };
  }
  const expiresAt = now + TTL_MS;
  await env.DB.prepare(
    'INSERT INTO otp_codes (identifier, codeHash, channel, expiresAt, consumedAt, attempts, createdAt) VALUES (?, ?, ?, ?, NULL, 0, ?)',
  )
    .bind(identifier, await hashSecret(code), channel, expiresAt, now)
    .run();
  return { ok: true, expiresAt };
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'no_code' | 'expired' | 'too_many_attempts' | 'invalid';
}

export async function verifyOtp(env: Env, identifier: string, code: string): Promise<VerifyResult> {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT codeHash, expiresAt, attempts, createdAt FROM otp_codes WHERE identifier = ? AND consumedAt IS NULL ORDER BY createdAt DESC LIMIT 1',
  )
    .bind(identifier)
    .first<{ codeHash: string; expiresAt: number; attempts: number; createdAt: number }>();
  if (!row) {
    return { ok: false, reason: 'no_code' };
  }
  if (now > row.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  await env.DB.prepare(
    'UPDATE otp_codes SET attempts = attempts + 1 WHERE identifier = ? AND createdAt = ?',
  )
    .bind(identifier, row.createdAt)
    .run();
  if (!(await verifySecret(code, row.codeHash))) {
    return { ok: false, reason: 'invalid' };
  }
  await env.DB.prepare(
    'UPDATE otp_codes SET consumedAt = ? WHERE identifier = ? AND createdAt = ?',
  )
    .bind(now, identifier, row.createdAt)
    .run();
  return { ok: true };
}

export function sendOtpViaEmail(env: Env, email: string, code: string): Promise<SendResult> {
  const subject = `Your BLACK BOX code: ${code}`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px">
<table role="presentation" align="center" style="max-width:420px;background:#fff;border-radius:12px;padding:24px">
<tr><td style="font-size:13px;color:#888;letter-spacing:.1em;text-transform:uppercase;font-family:monospace">BLACK BOX</td></tr>
<tr><td style="padding-top:12px;font-size:15px;color:#111">Your verification code is</td></tr>
<tr><td style="padding:8px 0;font-size:34px;font-weight:700;letter-spacing:.2em;color:#111">${code}</td></tr>
<tr><td style="font-size:12px;color:#888">It expires in 10 minutes. If you didn't request this, ignore this email.</td></tr>
</table></body></html>`;
  const text = `Your BLACK BOX verification code is ${code}. It expires in 10 minutes.`;
  return sendEmail(env, { to: email, subject, html, text }, 'otp');
}

/** SMS delivery is not configured in v0 (Twilio dropped). Stub placeholder. */
export function sendOtpViaSms(): { ok: false; channel: 'sms'; reason: 'sms_not_configured_in_v0' } {
  return { ok: false, channel: 'sms', reason: 'sms_not_configured_in_v0' };
}
