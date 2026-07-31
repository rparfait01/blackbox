/**
 * Automatic sealing (Brief 40 §F) — every terminal state produces a sealed artifact, with
 * nobody acting.
 *
 * WHY THIS EXISTS. Sealing used to happen only when a verified recipient pulled an export, so
 * on production nothing had ever been sealed: 0 vault objects against 5 closed events, while
 * coordinators had claimed and viewed every one of them. The gate was not broken — the
 * recipient ceremony was simply never completed — but the effect is the same and worse than a
 * bug, because the documentation described a vault that had never held anything.
 *
 * The case that matters most is the one where nobody is available to act at all: a seized,
 * smashed, or dead phone. That capture must still become a signed, sealed artifact, and it
 * cannot depend on a survivor, a coordinator, or a recipient doing anything afterwards.
 *
 * §F2 — CLOSURE NEVER WAITS ON SEALING, and this is the load-bearing rule of the file.
 * `enqueueSeal` is one INSERT that swallows its own errors; the actual sealing happens later
 * on the cron. Closure is a survivor's exit from a live alert, and no archival step may stand
 * between her and it, delay it, or fail it.
 *
 * §F3 — the drain follows §A's cursor pattern (primary-key walk, advance past failures,
 * inside the 20s job bound) and runs on the CRON, deliberately not on the integrity Durable
 * Object: Brief 37 §D bounds that object to integrity appends and event-scoped ordering, and
 * sealing is neither. One object must not become the place everything ends up.
 */

import { sealEvent } from './custody';
import { audit } from './audit';
import type { Env } from '../types';

/** Events sealed per cron run. Small: the 20s job bound is shared with seven other jobs. */
export const SEAL_BATCH = 10;

/** Bounded backoff so a permanently failing event cannot spin every minute forever. */
const BACKOFF_MS = [0, 60_000, 300_000, 900_000, 3_600_000];

/** A closed event unsealed longer than this is an operator alert (§F7). */
export const UNSEALED_ALERT_MS = 30 * 60 * 1000;

/**
 * §F2 — record that an event needs sealing. Called from every close path.
 *
 * NEVER THROWS, and never awaits anything slow. `INSERT OR IGNORE` on the event id makes it
 * idempotent (§F4), so a close path that fires twice, or two close paths that race, enqueue
 * exactly one unit of work.
 */
export async function enqueueSeal(env: Env, eventId: string, reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO seal_pending (eventId, reason, enqueuedAt, nextAttemptAt) VALUES (?, ?, ?, 0)',
    )
      .bind(eventId, reason, Date.now())
      .run();
  } catch (error) {
    // A failed enqueue must not fail the close. The cron's discovery pass finds this event
    // anyway — which is precisely why discovery exists alongside the queue.
    console.log(JSON.stringify({ level: 'error', message: 'enqueueSeal failed', eventId, detail: String(error) }));
  }
}

/**
 * Find closed events that have never been sealed and are not already queued, and queue them.
 *
 * THE GUARANTEE LIVES HERE, not in the enqueue calls. A future close path that forgets to
 * call `enqueueSeal` is still covered, because this asks the database the question directly:
 * which closed events have no vault object? Instrumenting N call sites is a promise; asking
 * the question is a fact.
 *
 * Canary events are excluded — Brief 35 §C keeps fixtures out of the vault entirely.
 */
async function discoverUnsealed(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT e.id FROM events e
      WHERE e.status = 'closed'
        AND e.isTest = 0
        AND NOT EXISTS (SELECT 1 FROM vault_objects v WHERE v.eventId = e.id)
        AND NOT EXISTS (SELECT 1 FROM seal_pending p WHERE p.eventId = e.id)
      ORDER BY e.closedAt ASC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of results ?? []) {
    await enqueueSeal(env, row.id, 'discovered');
  }
  return (results ?? []).length;
}

export interface SealDrainResult {
  discovered: number;
  attempted: number;
  sealed: number;
  failed: number;
}

/**
 * §F3 — drain the queue. One cron run, bounded, resumable.
 *
 * Ordered by eventId (the primary key) rather than by time, for the same reason §A walks
 * vaultKey: a timestamp can tie, and a tie makes a cursor skip or repeat. Each event is
 * attempted at most once per run and a failure advances past it, so one unsealable event
 * cannot wedge everything behind it.
 */
export async function drainSealQueue(env: Env, workerOrigin: string): Promise<SealDrainResult> {
  const discovered = await discoverUnsealed(env, SEAL_BATCH);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT eventId, attempts FROM seal_pending
      WHERE sealedAt IS NULL AND nextAttemptAt <= ?
      ORDER BY eventId ASC LIMIT ?`,
  )
    .bind(now, SEAL_BATCH)
    .all<{ eventId: string; attempts: number }>();

  let sealed = 0;
  let failed = 0;
  for (const row of results ?? []) {
    try {
      const result = await sealEvent(env, row.eventId, workerOrigin);
      if (result) {
        await env.DB.prepare('UPDATE seal_pending SET sealedAt = ?, lastError = NULL WHERE eventId = ?')
          .bind(Date.now(), row.eventId)
          .run();
        await audit(env, row.eventId, 'vault.sealed', null, {
          vaultKey: result.vaultKey,
          packageHash: result.packageHash.slice(0, 16),
        });
        sealed += 1;
        continue;
      }
      // sealEvent returned null: the event is not sealable (canary, or gone). Mark it done
      // rather than retrying forever — it is not an error, it is not eligible.
      await env.DB.prepare("UPDATE seal_pending SET sealedAt = ?, lastError = 'not_eligible' WHERE eventId = ?")
        .bind(Date.now(), row.eventId)
        .run();
    } catch (error) {
      failed += 1;
      const attempts = row.attempts + 1;
      const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
      await env.DB.prepare(
        'UPDATE seal_pending SET attempts = ?, nextAttemptAt = ?, lastError = ? WHERE eventId = ?',
      )
        .bind(attempts, Date.now() + backoff, String(error).slice(0, 200), row.eventId)
        .run();
      console.log(
        JSON.stringify({ level: 'error', alert: 'seal_failed', eventId: row.eventId, attempts, detail: String(error).slice(0, 200) }),
      );
    }
  }
  return { discovered, attempted: (results ?? []).length, sealed, failed };
}

export interface SealCoverage {
  pending: number;
  failed: number;
  sealedTotal: number;
  closedUnsealed: number;
  /** Age of the oldest closed-but-unsealed event, in ms. The §F7 alert watches this. */
  oldestUnsealedAgeMs: number | null;
}

/** §F7 — what the readiness panel reports, counted from the tables every time it is asked. */
export async function sealCoverage(env: Env): Promise<SealCoverage> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM seal_pending WHERE sealedAt IS NULL) AS pending,
       (SELECT COUNT(*) FROM seal_pending WHERE sealedAt IS NULL AND attempts > 0) AS failed,
       (SELECT COUNT(*) FROM seal_pending WHERE sealedAt IS NOT NULL) AS sealedTotal,
       (SELECT COUNT(*) FROM events e WHERE e.status = 'closed' AND e.isTest = 0
          AND NOT EXISTS (SELECT 1 FROM vault_objects v WHERE v.eventId = e.id)) AS closedUnsealed,
       (SELECT MIN(e.closedAt) FROM events e WHERE e.status = 'closed' AND e.isTest = 0
          AND NOT EXISTS (SELECT 1 FROM vault_objects v WHERE v.eventId = e.id)) AS oldestUnsealedAt`,
  ).first<{
    pending: number;
    failed: number;
    sealedTotal: number;
    closedUnsealed: number;
    oldestUnsealedAt: number | null;
  }>();
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    sealedTotal: Number(row?.sealedTotal ?? 0),
    closedUnsealed: Number(row?.closedUnsealed ?? 0),
    oldestUnsealedAgeMs: row?.oldestUnsealedAt ? Date.now() - row.oldestUnsealedAt : null,
  };
}

/**
 * §F7 — a closed event that has stayed unsealed past the threshold is an operator alert.
 *
 * Without this the failure mode is the one this whole section exists to fix: sealing quietly
 * not happening while everything reports healthy. Run from the cron, after the drain.
 */
export async function alertOnUnsealed(env: Env): Promise<void> {
  const coverage = await sealCoverage(env);
  if (coverage.oldestUnsealedAgeMs != null && coverage.oldestUnsealedAgeMs > UNSEALED_ALERT_MS) {
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'closed_event_unsealed',
        message: 'a closed event has remained unsealed past the threshold',
        closedUnsealed: coverage.closedUnsealed,
        oldestUnsealedAgeMinutes: Math.round(coverage.oldestUnsealedAgeMs / 60_000),
        failed: coverage.failed,
      }),
    );
  }
}
