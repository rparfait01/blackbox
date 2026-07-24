/**
 * k-anonymity suppression — ONE implementation, shared by every anonymized public
 * aggregate (Brief 25 tally, Brief 27 intake export). Two severed stores with different
 * schemas is fine; two suppression implementations is not — one would drift weaker. Any
 * published aggregate cell with fewer than the threshold rows is dropped entirely, because
 * a single rare combination can still point at a person even with coarse fields.
 */
import type { Env } from '../types';

/** Cells below this many rows are suppressed from publication. The default, not an option. */
export const SUPPRESSION_THRESHOLD = 10;

export interface SuppressedCell {
  [column: string]: string | number | null;
  count: number;
}

// Aggregate identifiers are INTERNAL code constants, never user input. This allowlist
// pattern is defense-in-depth so a future caller cannot turn a column name into injection.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Group `table` by `groupCols` and return only cells at or above SUPPRESSION_THRESHOLD —
 * the single k-anonymity gate. `table`/`groupCols` must be fixed identifiers from the
 * calling module (validated), never request input; the threshold is bound, not interpolated.
 */
export async function suppressedAggregate(
  env: Env,
  table: string,
  groupCols: string[],
): Promise<SuppressedCell[]> {
  if (!SAFE_IDENT.test(table) || groupCols.length === 0 || !groupCols.every((c) => SAFE_IDENT.test(c))) {
    throw new Error('suppressedAggregate: unsafe identifiers');
  }
  const cols = groupCols.join(', ');
  const { results } = await env.DB.prepare(
    `SELECT ${cols}, COUNT(*) AS count FROM ${table} GROUP BY ${cols} HAVING COUNT(*) >= ? ORDER BY ${groupCols[0]} DESC`,
  )
    .bind(SUPPRESSION_THRESHOLD)
    .all<SuppressedCell>();
  return results;
}
