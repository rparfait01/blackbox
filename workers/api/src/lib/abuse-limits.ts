/**
 * Brief 41 — ABUSE CONTROLS: COST THE ATTACKER, NEVER THE SURVIVOR.
 *
 * ═══ §0 — THE RULE THAT GOVERNS THIS FILE ═════════════════════════════════════════════════════
 *
 * No control here may ever apply to the trigger path, the capture path, the cascade, or closure.
 * A rate limit that delays an alert is a worse defect than the abuse it prevents.
 *
 * That rule is enforced by CONSTRUCTION rather than by care: `LIMITED` below is an explicit
 * allow-list, and `isLimited()` returns false for anything not on it. A new endpoint is unlimited
 * until somebody deliberately adds it. The inverse design — a deny-list of exempt paths — would
 * mean that forgetting to exempt a new capture route silently rate-limits a survivor's evidence,
 * and the failure would be invisible until the day it mattered.
 *
 * The exempt paths are additionally named in `EXEMPT` and asserted in tests. They are not needed
 * for correctness; they exist so that a reader, and a guard, can see the list §0 demands be
 * stated rather than implied.
 *
 * ═══ §A — PROGRESSIVE BACKOFF, NEVER LOCKOUT ══════════════════════════════════════════════════
 *
 * A survivor locked out of her own account is a safety failure. Nothing here ever produces a
 * terminal state: the delay grows, it caps, and it decays. Someone who mistypes an enrolment code
 * six times waits a few seconds, not a day, and never has to contact anyone (acceptance 8).
 *
 * ═══ §E3 — THE LIMITER FAILS OPEN ═════════════════════════════════════════════════════════════
 *
 * If the limiter's own store is unavailable the request is ALLOWED and the condition is alerted.
 * A limiter that fails closed takes down login for everyone — it converts a storage blip into an
 * outage of the front door, which is a strictly worse outcome than the abuse it was guarding.
 */
import type { Env } from '../types';

/**
 * §A — the limits, as stated constants with their reasoning.
 *
 * `windowMs` is the accounting window. `burst` is how many attempts are free — set above what a
 * confused human does, because the first job of these numbers is to never fire at a real person.
 * `backoffMs` is the delay applied to attempt `burst + n`, growing to `maxBackoffMs`.
 */
export interface LimitRule {
  key: string;
  windowMs: number;
  burst: number;
  backoffMs: number;
  maxBackoffMs: number;
  reason: string;
}

const MINUTE = 60_000;

/**
 * §0 — THE ALLOW-LIST. Only these are limited. Anything absent is unlimited by construction.
 *
 * Matching is by prefix on the pathname, and the paths are deliberately specific: `/v1/auth/` as
 * a whole is NOT listed, because that would sweep in anything added under it later without a
 * decision being made.
 */
export const LIMITED: Array<{ prefix: string; method?: string; rule: LimitRule }> = [
  {
    prefix: '/v1/auth/signin',
    rule: {
      key: 'signin',
      windowMs: 15 * MINUTE,
      burst: 10,
      backoffMs: 500,
      maxBackoffMs: 8_000,
      reason: 'password guessing against a known address',
    },
  },
  {
    prefix: '/v1/auth/magic/start',
    rule: {
      key: 'magic_start',
      // Tighter, because each attempt can spend a real email from the quota the alert path uses.
      windowMs: 15 * MINUTE,
      burst: 5,
      backoffMs: 1_000,
      maxBackoffMs: 15_000,
      reason: 'magic-link flooding an inbox, and draining outbound quota',
    },
  },
  {
    prefix: '/v1/auth/magic/consume',
    rule: { key: 'magic_consume', windowMs: 15 * MINUTE, burst: 10, backoffMs: 500, maxBackoffMs: 8_000, reason: 'magic token guessing' },
  },
  {
    prefix: '/v1/auth/recovery/consume',
    rule: { key: 'recovery', windowMs: 60 * MINUTE, burst: 8, backoffMs: 1_000, maxBackoffMs: 20_000, reason: 'recovery-code brute force' },
  },
  {
    prefix: '/v1/auth/signup/start',
    rule: {
      key: 'signup_start',
      windowMs: 60 * MINUTE,
      // Generous: a survivor mistyping an enrolment code from a card, in distress, on a bad
      // connection, must not be slowed to a stop. Acceptance 8 is this number.
      burst: 12,
      backoffMs: 750,
      maxBackoffMs: 10_000,
      reason: 'enrolment-code brute force',
    },
  },
  {
    prefix: '/v1/auth/passkey/login/options',
    rule: { key: 'passkey_challenge', windowMs: 15 * MINUTE, burst: 20, backoffMs: 250, maxBackoffMs: 4_000, reason: 'passkey challenge farming' },
  },
  {
    prefix: '/v1/console/auth',
    rule: { key: 'console_login', windowMs: 15 * MINUTE, burst: 8, backoffMs: 1_000, maxBackoffMs: 15_000, reason: 'console credential guessing' },
  },
];

/**
 * §0/§E2 — the paths that must NEVER be limited, named so the list is stated rather than implied.
 *
 * These are not consulted by `isLimited()` — the allow-list already excludes them. They are here
 * to be read, and to be asserted against in tests, which is what "proven, not asserted" requires.
 */
export const EXEMPT = [
  '/v1/events', // the trigger, and every event-scoped write beneath it — capture, heartbeat, close
  '/v1/c/', // coordinator surfaces: capability-scoped and ON the alert path (§E2)
  '/v1/me/checkin',
  '/v1/me/events', // owner event operations including consented purge
] as const;

/** True only for a path deliberately placed under a limit. */
export function ruleFor(pathname: string, method: string): LimitRule | null {
  for (const entry of LIMITED) {
    if (!pathname.startsWith(entry.prefix)) continue;
    if (entry.method && entry.method !== method.toUpperCase()) continue;
    return entry.rule;
  }
  return null;
}

export const isLimited = (pathname: string, method: string): boolean => ruleFor(pathname, method) !== null;

/** Defensive cross-check: nothing on the exempt list may ever resolve to a rule. */
export function exemptPathIsUnlimited(): { ok: boolean; offenders: string[] } {
  const offenders = EXEMPT.filter((p) => isLimited(p, 'POST') || isLimited(p, 'GET'));
  return { ok: offenders.length === 0, offenders: [...offenders] };
}

export type ExemptionReason = 'staging_environment' | 'canary_account' | null;

/**
 * §F — EXEMPTION IS BY IDENTITY, DERIVED SERVER-SIDE. NEVER BY A CLIENT ASSERTION.
 *
 * A blanket "test traffic is exempt" bypass is the shape Brief 35 Fix A §C removed from the deploy
 * gate: a control anything can opt out of is not a control. There are exactly two exemptions and
 * both are facts the server establishes for itself:
 *
 *   staging_environment  the acceptance suite runs against blackbox-api-staging, which is severed
 *                        to its own D1 and R2. Nothing it does can reach production data.
 *   canary_account       `isCanary = 1`, read from the users row at this moment (Brief 36 §G).
 *                        The canary can only reach reserved-range contacts, so it can spend no
 *                        real quota and reach no real person.
 *
 * Production acceptance runs are NOT exempt, deliberately. If the suite trips a production limit,
 * either the limit is wrong or the suite is — and that is a finding, not something to wave through.
 *
 * An exemption granted to anything else is an alertable operator condition, for the same reason a
 * suppression flag on a real account is.
 */
export function environmentExemption(env: Env): ExemptionReason {
  // The staging Worker is a different deployment with a different name; this is not a flag anyone
  // can set on a request.
  return /staging/i.test(env.WORKER_ORIGIN ?? '') ? 'staging_environment' : null;
}

export interface LimitDecision {
  allowed: boolean;
  /** Milliseconds the caller should be delayed before the next attempt succeeds. */
  retryAfterMs: number;
  rule: string;
  exemption: ExemptionReason;
  /** §E3 — set when the store could not be consulted and the request was allowed regardless. */
  failedOpen?: boolean;
}

/**
 * §A — progressive backoff from an attempt count. Pure, so the curve is inspectable and testable
 * without a store.
 *
 * Never returns `allowed: false` in a way that persists: the delay is what grows. A caller that
 * waits is always served, which is what distinguishes backoff from lockout.
 */
export function backoffFor(rule: LimitRule, attemptsInWindow: number): LimitDecision {
  if (attemptsInWindow <= rule.burst) {
    return { allowed: true, retryAfterMs: 0, rule: rule.key, exemption: null };
  }
  const over = attemptsInWindow - rule.burst;
  const delay = Math.min(rule.maxBackoffMs, rule.backoffMs * 2 ** (over - 1));
  return { allowed: false, retryAfterMs: delay, rule: rule.key, exemption: null };
}

/**
 * §C — the outbound quota, and the allocation abuse cannot reach.
 *
 * Brief 31 decoupled the test suite from the SendGrid quota; an unauthenticated attacker could
 * still drain it, which would take the alert path down without touching the alert path. So sends
 * are split: anything on the alert path draws on a RESERVED allocation that non-alert traffic is
 * never counted against and can never consume.
 *
 * The split is by message type, derived server-side from which code path is sending — not from
 * anything a caller supplies.
 */
export const ALERT_MESSAGE_TYPES = new Set([
  'alert',
  'escalation',
  'closure',
  'checkin',
  'guardian_alert',
  'all_channels_failed',
]);

/** Non-alert outbound sends an UNAUTHENTICATED caller can cause, per identifier per window. */
export const UNAUTH_OUTBOUND = {
  windowMs: 60 * MINUTE,
  max: 5,
  reason: 'unauthenticated outbound sends (magic link, OTP) per address per hour',
} as const;

export const isAlertMessage = (messageType: string): boolean => ALERT_MESSAGE_TYPES.has(messageType);
