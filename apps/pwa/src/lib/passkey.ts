/**
 * Passkey ceremonies, client side (Accounts §1).
 *
 * Every function here degrades rather than dead-ends. A survivor on a browser
 * without WebAuthn, or who dismisses the Face ID sheet, must always land somewhere
 * they can still get in — never on an error with no way forward. So support is
 * probed before anything is offered, and a cancelled ceremony is reported as
 * "cancelled", not as a failure.
 */

import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import { api } from '@/lib/api';
import type { DisplayMode } from '@/lib/auth';

/** True when this browser can do passkeys at all. Drives the magic-link fallback. */
export function passkeySupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export interface AuthSuccess {
  userId: string;
  sessionToken: string;
  displayMode: DisplayMode;
}

export type PasskeyOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unsupported' | 'cancelled' | 'failed' };

/**
 * A user dismissing the system sheet is NOT an error — it is a choice, and the UI
 * must offer the fallback rather than shout. WebAuthn reports both a cancel and a
 * timeout as NotAllowedError.
 */
function classify(err: unknown): 'cancelled' | 'failed' {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError' ? 'cancelled' : 'failed';
}

/** A short human label so the account self-view can say WHICH device holds a passkey. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'This device';
}

/**
 * Enroll a passkey. A signup CAPABILITY authenticates the call during onboarding (before a
 * session exists); once signed in, the Bearer token does instead.
 */
export async function enrollPasskey(capability?: string, bindNonce?: string): Promise<PasskeyOutcome<true>> {
  if (!passkeySupported()) return { ok: false, reason: 'unsupported' };
  const optionsRes = await api<PublicKeyCredentialCreationOptionsJSON>('/v1/auth/passkey/register/options', {
    auth: !capability,
    body: capability ? { capability, bindNonce } : {},
  });
  if (!optionsRes.ok || !optionsRes.data) return { ok: false, reason: 'failed' };

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: optionsRes.data });
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }

  const verifyRes = await api<{ ok?: boolean }>('/v1/auth/passkey/register/verify', {
    auth: !capability,
    body: { capability, bindNonce, response: attestation, deviceLabel: deviceLabel() },
  });
  if (!verifyRes.ok) return { ok: false, reason: 'failed' };
  return { ok: true, data: true };
}

/**
 * Sign in with a passkey. Usernameless — the browser offers whatever discoverable
 * credential it holds for this origin, so nothing is typed.
 */
export async function loginWithPasskey(): Promise<PasskeyOutcome<AuthSuccess>> {
  if (!passkeySupported()) return { ok: false, reason: 'unsupported' };
  const optionsRes = await api<PublicKeyCredentialRequestOptionsJSON>('/v1/auth/passkey/login/options', {
    auth: false,
    body: {},
  });
  if (!optionsRes.ok || !optionsRes.data) return { ok: false, reason: 'failed' };

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: optionsRes.data });
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }

  const verifyRes = await api<AuthSuccess>('/v1/auth/passkey/login/verify', {
    auth: false,
    body: { response: assertion },
  });
  if (!verifyRes.ok || !verifyRes.data?.sessionToken) return { ok: false, reason: 'failed' };
  return { ok: true, data: verifyRes.data };
}
