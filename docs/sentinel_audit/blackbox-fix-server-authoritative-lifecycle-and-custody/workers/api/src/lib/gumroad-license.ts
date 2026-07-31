/**
 * Gumroad license keys as access codes (Brief 34 §1).
 *
 * THE KEY THE BUYER ALREADY HAS *IS* THE CODE. We do not mint a second credential on
 * sale and mail it to them. That removes an entire class of failure at once:
 *
 *   - Gumroad's native Ping is UNSIGNED, so a fail-closed webhook rejects it and no code
 *     is ever minted. Every real sale needed a manual code. That is now moot: there is no
 *     webhook in the purchase path at all.
 *   - A minted code had to reach the buyer by email — a delivery that can bounce, land in
 *     spam, or (post-Brief 31) be suppressed. A buyer could pay and receive nothing. The
 *     license key is on their Gumroad receipt and in their library the moment they pay.
 *
 * VERIFICATION IS SERVER-TO-SERVER, against Gumroad, at signup. We never trust a
 * client-supplied claim that a purchase happened — the same rule as the Brief 28 webhook,
 * arrived at from the other direction.
 *
 * SINGLE USE IS OURS TO ENFORCE. Gumroad has its own uses counter, but incrementing it
 * would make OUR redemption depend on THEIR mutable state and would count a failed signup
 * as a use. So we verify with increment_uses_count=false and enforce one-key-one-account
 * in our own ledger, atomically.
 */
import type { Env } from '../types';
import { normalizeCode } from './readable-code';

const VERIFY_ENDPOINT = 'https://api.gumroad.com/v2/licenses/verify';

export type LicenseFailure =
  | 'not_configured'
  | 'invalid_license'
  | 'already_redeemed'
  | 'refunded_or_cancelled'
  | 'verify_unavailable';

export interface LicenseVerdict {
  ok: boolean;
  reason?: LicenseFailure;
  buyerEmail?: string | null;
}

/**
 * Ask Gumroad whether this key is a real, live purchase of OUR product.
 *
 * Deliberately does NOT increment Gumroad's uses counter: our ledger is the source of
 * truth for redemption, and a signup that fails after this point must not have burned
 * anything on their side either.
 */
export async function verifyGumroadLicense(
  env: Env,
  licenseKey: string,
): Promise<LicenseVerdict> {
  if (!env.GUMROAD_PRODUCT_ID) {
    // Fail-closed: with no product pinned we cannot tell OUR sale from anyone else's.
    return { ok: false, reason: 'not_configured' };
  }
  let res: Response;
  try {
    res = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        product_id: env.GUMROAD_PRODUCT_ID,
        license_key: licenseKey,
        increment_uses_count: 'false',
      }).toString(),
    });
  } catch {
    // Gumroad unreachable. We cannot confirm a purchase, so we cannot let the account
    // through — but we say so honestly rather than calling a paying customer's key invalid.
    return { ok: false, reason: 'verify_unavailable' };
  }

  if (res.status === 404) {
    return { ok: false, reason: 'invalid_license' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'verify_unavailable' };
  }

  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; purchase?: Record<string, unknown> }
    | null;
  if (!body?.success || !body.purchase) {
    return { ok: false, reason: 'invalid_license' };
  }

  const purchase = body.purchase;
  // A refunded, disputed, or cancelled sale is not an entitlement. Gumroad reports these
  // on the purchase; treating them as valid would let a refunded buyer keep access.
  const dead =
    purchase.refunded === true ||
    purchase.disputed === true ||
    purchase.chargebacked === true ||
    purchase.subscription_cancelled_at != null ||
    purchase.subscription_failed_at != null;
  if (dead) {
    return { ok: false, reason: 'refunded_or_cancelled' };
  }

  const buyerEmail = typeof purchase.email === 'string' ? purchase.email : null;
  return { ok: true, buyerEmail };
}

/**
 * Atomically claim a verified license key for ONE account.
 *
 * The claim is the INSERT itself: `code` is the PRIMARY KEY of enrollment_codes, so two
 * concurrent signups presenting the same fresh key both verify with Gumroad, both attempt
 * the insert, and exactly one lands — the other conflicts and is told the key is already
 * redeemed. Same guarantee as the conditional UPDATE used for minted codes, reached
 * through uniqueness rather than a counter, because for an externally-issued key the row
 * does not exist until someone claims it.
 *
 * Returns false when the key was already redeemed (by a prior signup or a racing one).
 */
export async function claimGumroadLicense(
  env: Env,
  licenseKey: string,
  buyerEmail: string | null,
  now: number,
): Promise<boolean> {
  const stored = normalizeCode(licenseKey);
  const res = await env.DB.prepare(
    `INSERT INTO enrollment_codes
       (code, source, orgId, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt, buyerEmail, redeemedAt)
     VALUES (?, 'consumer', NULL, 'survivor', NULL, 1, 1, 0, 'gumroad_license', ?, ?, ?)
     ON CONFLICT(code) DO NOTHING`,
  )
    .bind(stored, now, buyerEmail, now)
    .run();
  return res.meta.changes === 1;
}

/** Has this key already been redeemed on our side? Checked before calling Gumroad so a
 *  reused key is refused without a pointless round trip to their API. */
export async function licenseAlreadyRedeemed(env: Env, licenseKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS hit FROM enrollment_codes WHERE code = ? AND source = 'consumer'",
  )
    .bind(normalizeCode(licenseKey))
    .first<{ hit: number }>();
  return !!row;
}

/** Reader-facing reason, in the same honest register as the minted-code messages. */
export function licenseMessage(reason: LicenseFailure): string {
  switch (reason) {
    case 'invalid_license':
      return 'That licence key was not recognised. Check the key on your purchase receipt and try again.';
    case 'already_redeemed':
      return 'That licence key has already been used to create an account.';
    case 'refunded_or_cancelled':
      return 'That purchase was refunded or cancelled, so its licence key can no longer be used.';
    case 'verify_unavailable':
      return 'We could not reach the store to check your licence key. Please try again in a moment.';
    case 'not_configured':
    default:
      return 'Purchases cannot be verified on this deployment yet.';
  }
}
