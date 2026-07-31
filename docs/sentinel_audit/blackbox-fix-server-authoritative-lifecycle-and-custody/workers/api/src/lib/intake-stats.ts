/**
 * Intake anonymized export (Brief 27 §5, Destination 1) — a SEVERED public-good store.
 *
 * Its severance is HARDER than the tally's (Brief 25): the tally had no identified origin,
 * but this export derives from an identified case file, so filing time + case-file time
 * could correlate the two. The defenses, enforced structurally:
 *   - the stored row carries NO userId, NO caseFileId, NO event/capture link — no FK, no
 *     shared id, nothing to JOIN on to identified data;
 *   - it records only the SUBMISSION PERIOD (server-derived 'YYYY-MM'), never the filing
 *     instant — a precise timestamp would correlate the export with the case-file row;
 *   - only closed-vocabulary structured fields; there is no free-text column, ever;
 *   - the account authenticates the send (a spam floor + rate limit) but is NEVER written
 *     to the record — the record is inserted with a fresh random id.
 *   - published only as k-anonymized aggregates via the SHARED suppression (lib/suppression).
 *
 * This module touches exactly two tables: intake_stats (severed) and users (the rate
 * counter columns only). It NEVER reads or joins case_files or any identified table.
 */
import { rateDecision, submissionMonth } from './tally';
import { suppressedAggregate, type SuppressedCell } from './suppression';
import type { Env } from '../types';

/** A survivor may contribute a small number of anonymized exports per month. */
export const INTAKE_STAT_MONTHLY_LIMIT = 5;

const REPORTED = new Set(['yes', 'no', 'prefer_not_to_say']);
/** Cap on a closed-id field, as defense against any free text sneaking through. */
const MAX_ID = 48;
function cleanId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null;
}

export interface IntakeStatFields {
  incidentTypeId: string | null;
  whenRange: string | null;
  regionId: string | null;
  relationshipId: string | null;
  reportedToAuthorities: string | null;
}

/** Coerce an untrusted body into the closed structured fields — no free text can land. */
export function normalizeIntakeStat(body: Record<string, unknown>): IntakeStatFields {
  return {
    incidentTypeId: cleanId(body.incidentTypeId),
    whenRange: cleanId(body.whenRange),
    regionId: cleanId(body.regionId),
    relationshipId: cleanId(body.relationshipId),
    reportedToAuthorities:
      typeof body.reportedToAuthorities === 'string' && REPORTED.has(body.reportedToAuthorities)
        ? body.reportedToAuthorities
        : null,
  };
}

export type IntakeStatResult =
  | { ok: true }
  | { ok: false; reason: 'rate_limited'; used: number; limit: number };

/**
 * Rate-limit the SENDER (reusing the tally's pure rateDecision + a per-account monthly
 * counter on users), then store a SEVERED row. The userId advances the counter ONLY; it is
 * never part of the inserted row, and the row's only time granularity is the submission
 * month — never the filing instant.
 */
export async function submitIntakeStat(
  env: Env,
  userId: string,
  fields: IntakeStatFields,
  nowMs: number,
): Promise<IntakeStatResult> {
  const month = submissionMonth(nowMs);
  const acct = await env.DB.prepare('SELECT intakeStatMonth, intakeStatCount FROM users WHERE id = ?')
    .bind(userId)
    .first<{ intakeStatMonth: string | null; intakeStatCount: number }>();
  const verdict = rateDecision(
    { tallyMonth: acct?.intakeStatMonth ?? null, tallyCount: acct?.intakeStatCount ?? 0 },
    month,
    INTAKE_STAT_MONTHLY_LIMIT,
  );
  if (!verdict.allowed) {
    return { ok: false, reason: 'rate_limited', used: verdict.used, limit: verdict.limit };
  }
  await env.DB.prepare('UPDATE users SET intakeStatMonth = ?, intakeStatCount = ? WHERE id = ?')
    .bind(month, verdict.nextCount, userId)
    .run();
  // Severed insert: a fresh random id, the coarse fields, and the submission MONTH only —
  // no userId, no caseFileId, no precise timestamp.
  await env.DB.prepare(
    'INSERT INTO intake_stats (id, incidentTypeId, whenRange, regionId, relationshipId, reportedToAuthorities, submissionMonth) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      fields.incidentTypeId,
      fields.whenRange,
      fields.regionId,
      fields.relationshipId,
      fields.reportedToAuthorities,
      month,
    )
    .run();
  return { ok: true };
}

/** Published aggregate — the SHARED k-anonymity suppression, grouped on the coarse fields. */
export async function intakeStatsAggregate(env: Env): Promise<SuppressedCell[]> {
  return suppressedAggregate(env, 'intake_stats', [
    'submissionMonth',
    'regionId',
    'incidentTypeId',
    'whenRange',
    'relationshipId',
    'reportedToAuthorities',
  ]);
}
