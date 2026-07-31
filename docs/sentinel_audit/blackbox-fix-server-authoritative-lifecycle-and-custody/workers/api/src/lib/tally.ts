/**
 * Anonymous Incident Tally (Brief 25). Records THAT an incident occurred and whether
 * it was ever officially reported — nothing else. Structurally severed from identity:
 * the stored row (incident_tally) carries no link to any account/device/event, and
 * the account is used ONLY to rate-limit the sender, never written to the record.
 *
 * This module must NEVER read, derive from, or join to capture or event data (§1 hard
 * condition). It touches exactly two tables: incident_tally (the severed store) and
 * users (the rate-limit counter columns only).
 */
import { SUPPRESSION_THRESHOLD, suppressedAggregate } from './suppression';
import type { Env } from '../types';

/** How many tallies one account may submit per calendar month (§4 — small number). */
export const TALLY_MONTHLY_LIMIT = 3;

/** Re-exported so callers importing it from here keep working — the suppression THRESHOLD
 *  and logic are shared with every other anonymized aggregate (see lib/suppression.ts). */
export { SUPPRESSION_THRESHOLD };

/** The four questions. Every value is optional; a skipped question is null. There is
 *  deliberately NO free-text field anywhere in this type — free text is re-identifying. */
export interface TallySubmission {
  kind: string | null;
  roughlyWhen: string | null;
  regionId: string | null;
  reportedOfficial: string | null;
}

const KIND = new Set(['sexual_assault', 'sexual_harassment', 'domestic_violence', 'other', 'prefer_not_to_say']);
const WHEN = new Set(['this_month', 'past_3_months', 'past_year', 'longer_ago', 'prefer_not_to_say']);
const REPORTED = new Set(['yes', 'no', 'prefer_not_to_say']);

/** Accept only the closed enum values (or null). A value outside the set — the only
 *  way arbitrary/free text could reach the store — is coerced to null, never written. */
function clean(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

/** Normalize an untrusted body into the four closed-vocabulary values. regionId is
 *  validated by the caller against the known region set (a jurisdiction label). */
export function normalizeSubmission(
  body: { kind?: unknown; roughlyWhen?: unknown; reportedOfficial?: unknown },
): Omit<TallySubmission, 'regionId'> {
  return {
    kind: clean(body.kind, KIND),
    roughlyWhen: clean(body.roughlyWhen, WHEN),
    reportedOfficial: clean(body.reportedOfficial, REPORTED),
  };
}

/**
 * The submission month ('YYYY-MM') for a given instant, UTC. This is the ONLY time
 * granularity kept anywhere — a precise timestamp would be an identifier. Pure so the
 * month/rate-window logic is testable without a clock.
 */
export function submissionMonth(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export type RateVerdict =
  | { allowed: true; nextCount: number }
  | { allowed: false; used: number; limit: number };

/**
 * Pure rate rule: given the account's stored window/count and the current month,
 * decide whether another submission is allowed. A new month resets the count. Decoupled
 * from D1 so every branch is unit-testable.
 */
export function rateDecision(
  stored: { tallyMonth: string | null; tallyCount: number },
  month: string,
  limit: number = TALLY_MONTHLY_LIMIT,
): RateVerdict {
  const used = stored.tallyMonth === month ? stored.tallyCount : 0;
  if (used >= limit) return { allowed: false, used, limit };
  return { allowed: true, nextCount: used + 1 };
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'rate_limited'; used: number; limit: number };

/**
 * Rate-limit the SENDER (by userId), then store a SEVERED record. The userId is used
 * only to read/advance the per-account counter; it is never part of the inserted row.
 * Not perfectly atomic across the read→write, which is acceptable: the "attacker" is
 * the account holder themselves and the limit only guards against spam, not a race.
 */
export async function submitTally(
  env: Env,
  userId: string,
  submission: TallySubmission,
  nowMs: number,
): Promise<SubmitResult> {
  const month = submissionMonth(nowMs);
  const acct = await env.DB.prepare('SELECT tallyMonth, tallyCount FROM users WHERE id = ?')
    .bind(userId)
    .first<{ tallyMonth: string | null; tallyCount: number }>();
  const verdict = rateDecision(
    { tallyMonth: acct?.tallyMonth ?? null, tallyCount: acct?.tallyCount ?? 0 },
    month,
  );
  if (!verdict.allowed) {
    return { ok: false, reason: 'rate_limited', used: verdict.used, limit: verdict.limit };
  }
  // Advance the account counter (on the account, never on the record).
  await env.DB.prepare('UPDATE users SET tallyMonth = ?, tallyCount = ? WHERE id = ?')
    .bind(month, verdict.nextCount, userId)
    .run();
  // Insert the severed record — no userId, no device, no timestamp beyond the month.
  await env.DB.prepare(
    'INSERT INTO incident_tally (id, kind, roughlyWhen, regionId, reportedOfficial, submissionMonth) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      submission.kind,
      submission.roughlyWhen,
      submission.regionId,
      submission.reportedOfficial,
      month,
    )
    .run();
  return { ok: true };
}

export interface AggregateCell {
  submissionMonth: string;
  regionId: string | null;
  kind: string | null;
  roughlyWhen: string | null;
  reportedOfficial: string | null;
  count: number;
}

/**
 * Published aggregate (§6): the full coarse cross-tab (submission month × region ×
 * kind × roughly-when × reported-official) with small-count suppression. Any cell with
 * fewer than SUPPRESSION_THRESHOLD rows is dropped entirely — in a small region a
 * single rare combination can still point at a person even with these coarse fields, so
 * suppression is the default, and grouping on all four answers makes each cell more
 * sparse (hence more protected), not less. Returns only cells at or above the
 * threshold; the caller needs no auth (open public-good data).
 */
export async function tallyAggregate(env: Env): Promise<AggregateCell[]> {
  // Shared k-anonymity suppression (lib/suppression.ts) — one implementation for every
  // anonymized aggregate. The coarse cross-tab keeps cells sparse (hence more protected).
  const cells = await suppressedAggregate(env, 'incident_tally', [
    'submissionMonth',
    'regionId',
    'kind',
    'roughlyWhen',
    'reportedOfficial',
  ]);
  return cells as unknown as AggregateCell[];
}
