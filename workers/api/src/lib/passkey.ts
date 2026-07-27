/**
 * Passkeys (WebAuthn) — the PRIMARY credential (Accounts §1).
 *
 * Why passkeys are the right primitive for this product, not just a modern one:
 * a survivor has nothing to remember and nothing to write down, so there is no
 * credential an abuser can find on paper, guess from a birthday, or read out of a
 * monitored inbox. The secret never leaves the device's secure enclave, and it is
 * bound to this origin — it cannot be phished onto a lookalike page.
 *
 * The relying party is the PWA origin (PWA_ORIGIN), NOT the worker origin: the
 * ceremony runs in the survivor's browser against the page they see.
 *
 * Session compatibility is load-bearing: a passkey login mints the SAME
 * `<userId>.<issuedAt>.<hmac>` token as every other path (lib/session.ts). The
 * token format is not extended to record "how you logged in" — any new claim
 * changes the signed string and would invalidate every existing pilot session.
 * Auth method is recorded in the DB (webauthn_credentials), never in the token.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { Env } from '../types';

/** Ceremony challenges are single-use and short-lived. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const RP_NAME = 'BLACK BOX';

/**
 * Relying-party id = the PWA's registered domain (host only, no scheme/port).
 * Derived from PWA_ORIGIN so there is ONE source of truth for where the app
 * lives; a mismatch between rpID and the page origin makes every ceremony fail.
 */
export function rpId(env: Env): string | null {
  if (!env.PWA_ORIGIN) return null;
  try {
    return new URL(env.PWA_ORIGIN).hostname;
  } catch {
    return null;
  }
}

export function expectedOrigin(env: Env): string | null {
  return env.PWA_ORIGIN ?? null;
}

export interface CredentialRow {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
}

// Returns an ArrayBuffer-backed view explicitly: @simplewebauthn's types require
// Uint8Array<ArrayBuffer>, and Uint8Array.from infers the wider ArrayBufferLike.
const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Every passkey enrolled on an account. Used to list, and to exclude on re-register. */
export async function listCredentials(env: Env, userId: string): Promise<CredentialRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT credentialId, userId, publicKey, counter, transports FROM webauthn_credentials WHERE userId = ? ORDER BY createdAt',
  )
    .bind(userId)
    .all<CredentialRow>();
  return results ?? [];
}

/**
 * True when the account has at least one passkey. This is the gate that turns the
 * magic-link fallback OFF (§1b): once a survivor holds a passkey, email stops
 * being a way into the account, so an abuser with inbox access gets nothing.
 */
export async function hasPasskey(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS n FROM webauthn_credentials WHERE userId = ? LIMIT 1')
    .bind(userId)
    .first<{ n: number }>();
  return !!row;
}

async function storeChallenge(env: Env, challenge: string, userId: string | null, kind: 'register' | 'login'): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO webauthn_challenges (challenge, userId, kind, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(challenge, userId, kind, now + CHALLENGE_TTL_MS, now)
    .run();
}

/**
 * Take a challenge: read it and DELETE it in the same breath. Single-use — a
 * replayed ceremony finds nothing. Returns null if unknown, expired, or already
 * consumed.
 */
async function takeChallenge(
  env: Env,
  challenge: string,
  kind: 'register' | 'login',
): Promise<{ userId: string | null } | null> {
  const row = await env.DB.prepare(
    'SELECT userId, kind, expiresAt FROM webauthn_challenges WHERE challenge = ?',
  )
    .bind(challenge)
    .first<{ userId: string | null; kind: string; expiresAt: number }>();
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?').bind(challenge).run();
  if (!row || row.kind !== kind || row.expiresAt < Date.now()) return null;
  return { userId: row.userId };
}

/** Best-effort sweep of expired ceremonies (called opportunistically, never blocking). */
export async function pruneChallenges(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expiresAt < ?').bind(Date.now()).run();
}

/** Registration options for enrolling a passkey on `userId`. */
export async function registrationOptions(
  env: Env,
  user: { id: string; email: string; name: string },
): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
  const id = rpId(env);
  if (!id) return null;
  const existing = await listCredentials(env, user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: id,
    userName: user.email,
    userDisplayName: user.name,
    // Platform authenticator + resident key: Face ID / Touch ID / device PIN, and
    // discoverable so login needs no email typed first.
    //
    // residentKey MUST be 'required', not 'preferred'. THE ASYMMETRY THIS FIXES:
    // authenticationOptions() is deliberately usernameless — it sends NO
    // allowCredentials, so the browser can only offer a DISCOVERABLE (resident)
    // credential. With 'preferred', an authenticator is free to create a
    // NON-discoverable one: enrolment reports success, the credential is stored, and
    // then every sign-in fails because the browser has nothing it can offer for a
    // usernameless request. Enrol and authenticate must be symmetric — it must be
    // impossible to enrol a credential this login flow cannot find.
    //
    // requireResidentKey mirrors it for CTAP2.0 authenticators, which read the legacy
    // boolean rather than the newer enum.
    //
    // Cost, accepted: an authenticator with no room for a discoverable credential now
    // fails at ENROLMENT instead of silently succeeding and failing at every sign-in.
    // A visible failure while she still has another way in beats a credential that
    // looks enrolled and never works. Every platform authenticator this targets
    // (Face ID, Touch ID, Windows Hello, Google Password Manager) supports them.
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'preferred',
    },
    // Never enroll the same authenticator twice on one account.
    excludeCredentials: existing.map((cr) => ({
      id: cr.credentialId,
      transports: cr.transports ? (JSON.parse(cr.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
  });
  await storeChallenge(env, options.challenge, user.id, 'register');
  return options;
}

/** Verify an enrollment and persist the credential. Returns false on any mismatch. */
export async function verifyRegistration(
  env: Env,
  userId: string,
  response: RegistrationResponseJSON,
  deviceLabel: string | null,
): Promise<boolean> {
  const id = rpId(env);
  const origin = expectedOrigin(env);
  if (!id || !origin) return false;
  // The challenge the browser echoes back is the one we must have issued.
  const echoed = clientDataChallenge(response);
  if (!echoed) return false;
  const taken = await takeChallenge(env, echoed, 'register');
  if (!taken || taken.userId !== userId) return false;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: echoed,
      expectedOrigin: origin,
      expectedRPID: id,
      requireUserVerification: false,
    });
  } catch {
    return false;
  }
  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential } = verification.registrationInfo;
  const now = Date.now();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO webauthn_credentials (credentialId, userId, publicKey, counter, transports, deviceLabel, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
  )
    .bind(
      credential.id,
      userId,
      bytesToB64url(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      deviceLabel,
      now,
    )
    .run();
  return true;
}

/**
 * Authentication options. Usernameless by design: no allowCredentials, so the
 * browser offers whatever discoverable passkey it holds for this origin and the
 * survivor never types an email to sign in.
 */
export async function authenticationOptions(env: Env): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const id = rpId(env);
  if (!id) return null;
  const options = await generateAuthenticationOptions({
    rpID: id,
    userVerification: 'preferred',
  });
  await storeChallenge(env, options.challenge, null, 'login');
  return options;
}

/**
 * Verify a login ceremony. Returns the authenticated userId, or null.
 * The userId comes from the stored credential — never from anything the client
 * asserts — so a client cannot log in as someone else by claiming their id.
 */
export async function verifyAuthentication(
  env: Env,
  response: AuthenticationResponseJSON,
): Promise<string | null> {
  const id = rpId(env);
  const origin = expectedOrigin(env);
  if (!id || !origin) return null;
  const echoed = clientDataChallenge(response);
  if (!echoed) return null;
  const taken = await takeChallenge(env, echoed, 'login');
  if (!taken) return null;

  const cred = await env.DB.prepare(
    'SELECT credentialId, userId, publicKey, counter, transports FROM webauthn_credentials WHERE credentialId = ?',
  )
    .bind(response.id)
    .first<CredentialRow>();
  if (!cred) return null;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: echoed,
      expectedOrigin: origin,
      expectedRPID: id,
      requireUserVerification: false,
      credential: {
        id: cred.credentialId,
        publicKey: b64urlToBytes(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[]) : undefined,
      },
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;

  // Advance the signature counter (clone detection) and stamp last use.
  await env.DB.prepare('UPDATE webauthn_credentials SET counter = ?, lastUsedAt = ? WHERE credentialId = ?')
    .bind(verification.authenticationInfo.newCounter, Date.now(), cred.credentialId)
    .run();
  return cred.userId;
}

/** The challenge the authenticator signed, read back out of clientDataJSON. */
function clientDataChallenge(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(b64urlToBytes(response.response.clientDataJSON))) as {
      challenge?: string;
    };
    return typeof json.challenge === 'string' && json.challenge ? json.challenge : null;
  } catch {
    return null;
  }
}
