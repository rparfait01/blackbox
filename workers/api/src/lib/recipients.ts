/**
 * Recipient identity — mint-on-access (Fix Brief 2 #C1). BLACK BOX is its own
 * authority: there is no external federated ID. The FIRST time a dispatch/export
 * token is claimed, the recipient must register (full name, agency, role/badge,
 * a contact verified by one-time challenge) BEFORE any evidence renders. We mint
 * an immutable RCP-<uuid> and bind it to the token (by token hash) and to the
 * event. Every later action is logged against that id. No anonymous access.
 *
 * Canonical time is UTC ms + offset (#C6).
 */

import { sha256Hex } from '@blackbox/shared';
import type { Env } from '../types';
import { generateOtp, sendOtpViaEmail, storeOtp, verifyOtp } from './otp';
import { normalizeEmail } from './users';
import { bumpTrust } from './trust';

export interface RecipientRow {
  id: string;
  fullName: string;
  agency: string;
  roleRef: string | null;
  contactType: string;
  contactValue: string;
  verificationStatus: string;
  verifiedAt: number | null;
  firstSeenAt: number;
  tzOffsetMinutes: number | null;
}

export async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export async function logRecipientAction(
  env: Env,
  recipientId: string,
  eventId: string | null,
  action: string,
  detail?: string,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO recipient_actions (id, recipientId, eventId, action, detail, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), recipientId, eventId, action, detail ?? null, Date.now(), 0)
    .run();
}

/** The recipient bound to a token for an event, if any (verified or pending). */
export async function getBinding(
  env: Env,
  eventId: string,
  token: string,
): Promise<{ recipient: RecipientRow; scope: string } | null> {
  const th = await tokenHash(token);
  const binding = await env.DB.prepare(
    'SELECT recipientId, scope FROM recipient_bindings WHERE eventId = ? AND tokenHash = ? LIMIT 1',
  )
    .bind(eventId, th)
    .first<{ recipientId: string; scope: string }>();
  if (!binding) {
    return null;
  }
  const recipient = await env.DB.prepare('SELECT * FROM recipients WHERE id = ?')
    .bind(binding.recipientId)
    .first<RecipientRow>();
  return recipient ? { recipient, scope: binding.scope } : null;
}

export async function getVerifiedRecipient(
  env: Env,
  eventId: string,
  token: string,
): Promise<RecipientRow | null> {
  const bound = await getBinding(env, eventId, token);
  return bound && bound.recipient.verificationStatus === 'verified' ? bound.recipient : null;
}

export interface RegisterInput {
  fullName: string;
  agency: string;
  roleRef?: string;
  contactType: 'email';
  contactValue: string;
  scope: 'dispatch' | 'export';
}

/**
 * Begin registration: mint the recipient (pending), bind it to the token, send
 * the verification challenge. Re-registering on the same token replaces the
 * pending recipient (idempotent until verified).
 */
export async function registerRecipient(
  env: Env,
  eventId: string,
  token: string,
  input: RegisterInput,
): Promise<{ ok: true; recipientId: string; expiresAt: number } | { ok: false; error: string; status: number }> {
  if (!input.fullName?.trim() || !input.agency?.trim() || !input.contactValue?.trim()) {
    return { ok: false, error: 'name, agency and contact are required', status: 400 };
  }
  if (input.contactType !== 'email') {
    return { ok: false, error: 'email contact required in v0', status: 400 };
  }
  const email = normalizeEmail(input.contactValue);
  const th = await tokenHash(token);

  // Reuse an existing pending recipient for this token; only mint once verified
  // recipients are immutable.
  const existing = await getBinding(env, eventId, token);
  let recipientId: string;
  if (existing && existing.recipient.verificationStatus !== 'verified') {
    recipientId = existing.recipient.id;
    await env.DB.prepare(
      'UPDATE recipients SET fullName = ?, agency = ?, roleRef = ?, contactType = ?, contactValue = ? WHERE id = ?',
    )
      .bind(input.fullName.trim(), input.agency.trim(), input.roleRef ?? null, 'email', email, recipientId)
      .run();
  } else if (existing) {
    return { ok: false, error: 'already registered', status: 409 };
  } else {
    recipientId = `RCP-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO recipients (id, fullName, agency, roleRef, contactType, contactValue, verificationStatus, firstSeenAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, 'email', ?, 'pending', ?, ?)",
      ).bind(recipientId, input.fullName.trim(), input.agency.trim(), input.roleRef ?? null, email, Date.now(), 0),
      env.DB.prepare(
        'INSERT INTO recipient_bindings (id, recipientId, eventId, scope, tokenHash, boundAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), recipientId, eventId, input.scope, th, Date.now(), 0),
    ]);
  }

  const code = generateOtp();
  const stored = await storeOtp(env, `recipient:${recipientId}:${email}`, code, 'email');
  if (!stored.ok) {
    return { ok: false, error: stored.reason ?? 'otp_failed', status: 429 };
  }
  const sent = await sendOtpViaEmail(env, email, code);
  if (!sent.ok) {
    return { ok: false, error: 'email_send_failed', status: 502 };
  }
  await logRecipientAction(env, recipientId, eventId, 'register', `${input.agency.trim()} / ${input.roleRef ?? ''}`);
  // Challenge issued counts toward trust (answering it raises the score).
  await bumpTrust(
    env,
    [
      { type: 'recipient', id: recipientId },
      { type: 'agency', id: input.agency.trim() },
    ],
    { challengesIssued: 1 },
  );
  return { ok: true, recipientId, expiresAt: stored.expiresAt ?? Date.now() };
}

/** Complete verification: check the OTP and bind the identity immutably. */
export async function verifyRecipient(
  env: Env,
  eventId: string,
  token: string,
  code: string,
): Promise<{ ok: true; recipientId: string } | { ok: false; error: string; status: number }> {
  const bound = await getBinding(env, eventId, token);
  if (!bound) {
    return { ok: false, error: 'no registration in progress', status: 404 };
  }
  const recipient = bound.recipient;
  if (recipient.verificationStatus === 'verified') {
    return { ok: true, recipientId: recipient.id };
  }
  const result = await verifyOtp(env, `recipient:${recipient.id}:${recipient.contactValue}`, code);
  if (!result.ok) {
    return { ok: false, error: result.reason ?? 'invalid', status: 400 };
  }
  await env.DB.prepare(
    "UPDATE recipients SET verificationStatus = 'verified', verifiedAt = ? WHERE id = ?",
  )
    .bind(Date.now(), recipient.id)
    .run();
  await logRecipientAction(env, recipient.id, eventId, 'verify', 'identity verified');
  await bumpTrust(
    env,
    [
      { type: 'recipient', id: recipient.id },
      { type: 'agency', id: recipient.agency },
    ],
    { identityVerified: true, challengesAnswered: 1 },
  );
  return { ok: true, recipientId: recipient.id };
}
