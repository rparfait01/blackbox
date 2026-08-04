/**
 * Brief 30 Fix A — A HANDLE IS NOT A CREDENTIAL.
 *
 * WHAT WAS ACTUALLY WRONG, and it was worse than "signup hygiene". `signupId` was the account's
 * permanent `users.id`, returned by `/signup/start` and accepted as authorization by
 * `/signup/finalize`, `/passkey/register/` and `/recovery/issue`. None of those checked that the
 * account was still a draft. Proven on staging before this was written:
 *
 *   POST /v1/auth/signup/finalize {signupId: <any userId>, displayMode: 'direct'}
 *     → 200 with a VALID SESSION TOKEN for that account, no credential of any kind.
 *     → the session authenticated to /v1/me and returned the owner's name, email and entitlement.
 *     → the victim's displayMode was flipped covert → direct. For this product that is a
 *       survivor's Hidden-mode disguise being removed by an unauthenticated stranger.
 *   POST /v1/auth/recovery/issue {signupId: <any userId>}
 *     → minted fresh recovery codes and invalidated the owner's set.
 *
 * And `users.id` is not a secret. It is returned by /signin, /magic/consume and
 * /passkey/login/verify, it is printed by admin tooling, and it is the literal first component of
 * every session token (`<userId>.<issuedAt>.<sig>`) — so any leaked session token also leaks a
 * permanent, non-expiring key to the account it belonged to.
 *
 * THE RULE, from the corrected Brief 30 §C: signup state is carried by a signed, scoped,
 * short-lived capability. An identifier returned by an earlier step is a handle, never an
 * authorization. Possession of a handle grants nothing.
 *
 * ── §D — LOCKOUT IS WORSE THAN EXPIRY ─────────────────────────────────────────────────────────
 * A broken gate blocks account creation, and the person being blocked may be in danger. So the
 * lifetime is generous and the failure is always recoverable: 60 minutes, chosen for a real
 * person on a slow connection reading an onboarding screen, choosing a display mode, and
 * enrolling a passkey — with interruptions. Expiry returns `capability_expired`, which the client
 * turns into a self-service restart. There is no path here that ends in "contact support".
 *
 * ── §E1 — CLOCK SKEW ──────────────────────────────────────────────────────────────────────────
 * Every timestamp is SERVER time. `iat`/`exp` are stamped and compared here; no client-supplied
 * time is read for any decision. A device with a wrong clock signs up normally.
 *
 * ── §E3 — KEY ROTATION ────────────────────────────────────────────────────────────────────────
 * Verification accepts any key in the active set (current + previous), the same discipline as
 * Brief 39 §C. Minting always uses the current key. A rotation therefore never invalidates an
 * in-flight signup — the alternative is a deploy that locks out everyone mid-onboarding, which is
 * the §D failure wearing a different hat.
 */
import type { Env } from '../types';
import { hmacSha256Hex } from '@blackbox/shared';

/** §A — the exact steps a capability may authorize. A step-2 token does not authorize step 4. */
export type SignupScope = 'signup:finalize' | 'signup:passkey' | 'signup:recovery';

export const ALL_SIGNUP_SCOPES: SignupScope[] = ['signup:finalize', 'signup:passkey', 'signup:recovery'];

/**
 * §D — 60 minutes, stated with its reasoning. Long enough for a real person on a slow connection
 * to finish onboarding including a passkey ceremony and an interruption or two; short enough that
 * a capability recovered from a screenshot an hour later is already dead.
 */
export const CAPABILITY_TTL_MS = 60 * 60 * 1000;

const VERSION = 'bbxcap1';

export interface CapabilityClaims {
  jti: string;
  sub: string;
  scope: SignupScope[];
  iat: number;
  exp: number;
  /** §B — commitment to something the requester holds. Never the value itself. */
  bind: string | null;
}

export type CapabilityFailure =
  | 'capability_missing'
  | 'capability_malformed'
  | 'capability_bad_signature'
  | 'capability_expired'
  | 'capability_out_of_scope'
  | 'capability_replayed'
  | 'capability_binding_mismatch'
  | 'server_misconfigured';

export interface CapabilityResult {
  ok: boolean;
  claims?: CapabilityClaims;
  reason?: CapabilityFailure;
}

/** base64url without padding — safe in a JSON body and in a header. */
function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
}
const encode = (o: unknown): string => b64u(new TextEncoder().encode(JSON.stringify(o)));

/**
 * §E3 — the verification key set: current first, then previous. Falls back to the session secret
 * only when no dedicated secret is configured, so an environment that has not yet been given
 * SIGNUP_CAPABILITY_SECRET still signs capabilities rather than silently accepting bare handles.
 * A capability scheme that degrades to "no capability" under misconfiguration is not a gate.
 */
export function capabilityKeys(env: Env): string[] {
  const keys = [env.SIGNUP_CAPABILITY_SECRET, env.SIGNUP_CAPABILITY_SECRET_PREVIOUS, env.SESSION_SECRET]
    .map((k) => (k ?? '').trim())
    .filter((k) => k.length > 0);
  return [...new Set(keys)];
}

/** Sign with the CURRENT key (the first in the set). */
export async function mintCapability(
  env: Env,
  input: { sub: string; scope: SignupScope[]; bind?: string | null; now?: number },
): Promise<string | null> {
  const [key] = capabilityKeys(env);
  if (!key) return null;
  const now = input.now ?? Date.now(); // §E1 — server time, always
  const claims: CapabilityClaims = {
    jti: crypto.randomUUID(),
    sub: input.sub,
    scope: input.scope,
    iat: now,
    exp: now + CAPABILITY_TTL_MS,
    bind: input.bind ?? null,
  };
  const payload = encode(claims);
  const sig = await hmacSha256Hex(key, `${VERSION}.${payload}`);
  return `${VERSION}.${payload}.${sig}`;
}

/**
 * Verify signature, expiry, scope and binding. PURE with respect to storage — replay is checked
 * separately by the caller so this stays testable without a database.
 */
export async function verifyCapability(
  env: Env,
  token: string | undefined | null,
  required: SignupScope,
  opts: { bindNonce?: string | null; now?: number } = {},
): Promise<CapabilityResult> {
  if (!token) return { ok: false, reason: 'capability_missing' };
  const keys = capabilityKeys(env);
  if (keys.length === 0) return { ok: false, reason: 'server_misconfigured' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'capability_malformed' };
  const [, payload, sig] = parts as [string, string, string];

  // §E3 — any key in the active set. Current first, previous still honoured until expiry.
  // The MATCHING key is kept: it is by definition the key that minted this capability, and the
  // binding below must be checked with that same key rather than with whatever is current now.
  let signingKey: string | null = null;
  for (const key of keys) {
    const expected = await hmacSha256Hex(key, `${VERSION}.${payload}`);
    if (timingSafeEqual(expected, sig)) {
      signingKey = key;
      break;
    }
  }
  if (!signingKey) return { ok: false, reason: 'capability_bad_signature' };

  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(b64uDecode(payload)) as CapabilityClaims;
  } catch {
    return { ok: false, reason: 'capability_malformed' };
  }
  if (!claims?.sub || !Array.isArray(claims.scope) || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'capability_malformed' };
  }

  const now = opts.now ?? Date.now(); // §E1 — server time only
  if (now >= claims.exp) return { ok: false, reason: 'capability_expired' };
  if (!claims.scope.includes(required)) return { ok: false, reason: 'capability_out_of_scope' };

  /**
   * §B — the binding, checked with THE KEY THAT SIGNED THIS TOKEN.
   *
   * The first version recomputed the commitment with `capabilityKeys(env)[0]` — whatever key is
   * current in this isolate at this instant. That is wrong twice over. Across a rotation the
   * minting key is no longer current, so every in-flight capability fails; and even without a
   * rotation, secret propagation across isolates is not atomic, so two requests in the same
   * signup can be served by isolates that disagree about which key is current. Both were
   * observed: a real rotation on staging refused BOTH an in-flight capability and a freshly
   * minted one.
   *
   * Using the key that verified the signature removes the question entirely — that key minted
   * this token, so it is the one that produced this commitment.
   */
  if (claims.bind) {
    if (!opts.bindNonce) return { ok: false, reason: 'capability_binding_mismatch' };
    const expectedBind = await bindingCommitment(signingKey, opts.bindNonce);
    if (!timingSafeEqual(expectedBind, claims.bind)) {
      return { ok: false, reason: 'capability_binding_mismatch' };
    }
  }

  return { ok: true, claims };
}

/** The commitment stored in a capability's `bind` claim. Keyed, so it reveals nothing. */
export async function bindingCommitment(key: string, nonce: string): Promise<string> {
  return (await hmacSha256Hex(key, `bind.${nonce}`)).slice(0, 32);
}

/** Mint-time helper: commit with the CURRENT key, which verification will then rediscover. */
export async function mintBinding(env: Env, nonce: string): Promise<string | null> {
  const [key] = capabilityKeys(env);
  return key ? bindingCommitment(key, nonce) : null;
}

/** Constant-time compare so a signature cannot be discovered a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * §B — single use, for steps that are not idempotent. Consumption is an INSERT that fails on the
 * primary key, so two concurrent replays cannot both win; the loser is rejected and audited.
 */
export async function consumeCapability(env: Env, claims: CapabilityClaims): Promise<boolean> {
  try {
    const r = await env.DB.prepare(
      'INSERT OR IGNORE INTO consumed_capabilities (jti, userId, scope, consumedAt) VALUES (?, ?, ?, ?)',
    )
      .bind(claims.jti, claims.sub, claims.scope.join(','), Date.now())
      .run();
    // `changes === 0` means the row already existed — this jti has been spent.
    return (r.meta?.changes ?? 0) > 0;
  } catch {
    // §D — a storage failure must not become a lockout. Fail OPEN on infrastructure error but
    // never on a proven replay: the row above is the only thing that proves replay, and if we
    // could not read it we do not get to claim one happened.
    return true;
  }
}

/** §C — what an audit row may carry. The identifier and scope, never the token. */
export function auditableCapability(claims: CapabilityClaims): Record<string, unknown> {
  return { jti: claims.jti, scope: claims.scope.join(','), expiresAt: claims.exp };
}
