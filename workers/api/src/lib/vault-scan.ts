/**
 * Vault scan coverage (Brief 40 §A) — every eligible object, proven by a cursor.
 *
 * THE DEFECT. The scan read `ORDER BY sealedAt ASC LIMIT 50` with no cursor, so every run
 * re-examined the same fifty rows. Past fifty eligible objects the tail was never reached,
 * and nothing said so: the job completed, logged nothing unusual, and reported no coverage
 * figure at all. Partial coverage that announces itself is a capacity problem; partial
 * coverage that does not is a false retention guarantee.
 *
 * WHY A CURSOR AND NOT A BIGGER CAP. Brief 36 §11 bounds every cron job at 20s because a job
 * that overruns silently starves the ones behind it — the integrity scan and the canary TTL
 * sweep were the two that got starved. Raising the cap would trade one silent failure for
 * another. The cursor makes a bounded job and full coverage compatible: a run does not have
 * to FINISH, it has to RESUME and record that it did.
 *
 * COVERAGE IS A CLAIM, SO IT IS MEASURED. A completed pass records what it examined and how
 * many objects were still unverified when it finished. That last number should be zero; if it
 * is not, for several passes running, the scan is falling behind and an operator is told at
 * error level. The original defect was precisely a scan that fell behind and never mentioned
 * it.
 */

import { hashBytes, openInvestigation } from './integrity';
import { audit } from './audit';
import type { Env } from '../types';
import { operatorAlert } from './operator-alert';

/** Objects examined per run. Small on purpose: the 20s job bound is not to be spent here. */
export const SCAN_BATCH = 25;

/** Consecutive COMPLETED passes that may end with unverified objects before it is an alert. */
export const BACKLOG_ALERT_PASSES = 3;

interface ScanState {
  cursor: string | null;
  passNumber: number;
  passStartedAt: number | null;
  examinedThisPass: number;
  verifiedThisPass: number;
  consecutiveBacklogPasses: number;
}

async function readState(env: Env): Promise<ScanState> {
  const row = await env.DB.prepare(
    'SELECT cursor, passNumber, passStartedAt, examinedThisPass, verifiedThisPass, consecutiveBacklogPasses FROM vault_scan_state WHERE id = 1',
  ).first<ScanState>();
  return (
    row ?? {
      cursor: null,
      passNumber: 0,
      passStartedAt: null,
      examinedThisPass: 0,
      verifiedThisPass: 0,
      consecutiveBacklogPasses: 0,
    }
  );
}

export interface VaultCoverage {
  eligible: number;
  verified: number;
  neverVerified: number;
  /** Age in ms of the oldest object that has never been verified, or null. */
  oldestUnverifiedAgeMs: number | null;
  passNumber: number;
  passInFlight: boolean;
  lastPassCompletedAt: number | null;
  lastPassExamined: number | null;
  lastPassBacklog: number;
  consecutiveBacklogPasses: number;
}

/** §A/§12 — what the readiness panel reports, counted from the tables every time it is asked. */
export async function vaultCoverage(env: Env): Promise<VaultCoverage> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM vault_objects) AS eligible,
       (SELECT COUNT(*) FROM vault_objects WHERE lastVerifiedAt IS NOT NULL) AS verified,
       (SELECT COUNT(*) FROM vault_objects WHERE lastVerifiedAt IS NULL) AS neverVerified,
       (SELECT MIN(sealedAt) FROM vault_objects WHERE lastVerifiedAt IS NULL) AS oldestUnverifiedAt,
       s.passNumber AS passNumber,
       s.cursor AS cursor,
       s.lastPassCompletedAt AS lastPassCompletedAt,
       s.lastPassExamined AS lastPassExamined,
       s.lastPassBacklog AS lastPassBacklog,
       s.consecutiveBacklogPasses AS consecutiveBacklogPasses
     FROM vault_scan_state s WHERE s.id = 1`,
  ).first<{
    eligible: number;
    verified: number;
    neverVerified: number;
    oldestUnverifiedAt: number | null;
    passNumber: number;
    cursor: string | null;
    lastPassCompletedAt: number | null;
    lastPassExamined: number | null;
    lastPassBacklog: number;
    consecutiveBacklogPasses: number;
  }>();
  return {
    eligible: Number(row?.eligible ?? 0),
    verified: Number(row?.verified ?? 0),
    neverVerified: Number(row?.neverVerified ?? 0),
    oldestUnverifiedAgeMs: row?.oldestUnverifiedAt ? Date.now() - row.oldestUnverifiedAt : null,
    passNumber: Number(row?.passNumber ?? 0),
    passInFlight: row?.cursor != null,
    lastPassCompletedAt: row?.lastPassCompletedAt ?? null,
    lastPassExamined: row?.lastPassExamined ?? null,
    lastPassBacklog: Number(row?.lastPassBacklog ?? 0),
    consecutiveBacklogPasses: Number(row?.consecutiveBacklogPasses ?? 0),
  };
}

/**
 * One RUN of the scan — not one pass. Examines up to SCAN_BATCH objects starting after the
 * stored cursor, advances the cursor, and closes the pass when the end is reached.
 *
 * Never throws into the cron chain: a scan failure must not take the jobs behind it down,
 * which is the same reasoning that bounded them in the first place.
 */
export async function runVaultScan(env: Env, workerOrigin: string): Promise<void> {
  if (!env.VAULT) {
    return;
  }
  const state = await readState(env);
  const now = Date.now();
  const passStartedAt = state.cursor == null ? now : (state.passStartedAt ?? now);

  const { results } = await env.DB.prepare(
    // `> cursor` on the primary key: no row is examined twice and none is skipped, which a
    // LIMIT with no cursor could not promise.
    `SELECT vaultKey, eventId, packageHash FROM vault_objects
      WHERE (? IS NULL OR vaultKey > ?) ORDER BY vaultKey ASC LIMIT ?`,
  )
    .bind(state.cursor, state.cursor, SCAN_BATCH)
    .all<{ vaultKey: string; eventId: string; packageHash: string }>();
  const batch = results ?? [];

  let examined = 0;
  let verified = 0;
  let lastKey = state.cursor;

  for (const row of batch) {
    try {
      const obj = await env.VAULT.get(row.vaultKey);
      if (!obj) {
        await openInvestigation(env, workerOrigin, {
          eventId: row.eventId,
          kind: 'vault_missing',
          detail: `Sealed object ${row.vaultKey} is missing from the vault.`,
        });
      } else {
        const actual = await hashBytes(new Uint8Array(await obj.arrayBuffer()));
        if (actual !== row.packageHash) {
          await openInvestigation(env, workerOrigin, {
            eventId: row.eventId,
            kind: 'vault_mismatch',
            detail: `Vault object ${row.vaultKey} hash mismatch: expected ${row.packageHash}, got ${actual}.`,
          });
        } else {
          await env.DB.prepare('UPDATE vault_objects SET lastVerifiedAt = ? WHERE vaultKey = ?')
            .bind(Date.now(), row.vaultKey)
            .run();
          verified += 1;
        }
      }
    } catch (error) {
      console.log(JSON.stringify({ level: 'error', message: 'vault scan object failed', key: row.vaultKey, detail: String(error) }));
    }
    examined += 1;
    // The cursor advances even for an object that failed verification. An object that cannot
    // be read must not wedge the pass on itself forever — the investigation is the record
    // that it is broken, and the scan has to keep going to cover everything behind it.
    lastKey = row.vaultKey;
  }

  const passComplete = batch.length < SCAN_BATCH;
  const totalExamined = state.examinedThisPass + examined;
  const totalVerified = state.verifiedThisPass + verified;

  if (!passComplete) {
    await env.DB.prepare(
      'UPDATE vault_scan_state SET cursor = ?, passStartedAt = ?, examinedThisPass = ?, verifiedThisPass = ? WHERE id = 1',
    )
      .bind(lastKey, passStartedAt, totalExamined, totalVerified)
      .run();
    return;
  }

  // ---- pass complete -------------------------------------------------------------------
  // BACKLOG: objects whose last verification predates this pass (or never happened). A
  // completed pass should leave none. Anything else means coverage is losing to growth.
  const backlogRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM vault_objects WHERE lastVerifiedAt IS NULL OR lastVerifiedAt < ?',
  )
    .bind(passStartedAt)
    .first<{ n: number }>();
  const backlog = Number(backlogRow?.n ?? 0);
  const consecutive = backlog > 0 ? state.consecutiveBacklogPasses + 1 : 0;

  await env.DB.prepare(
    `UPDATE vault_scan_state
        SET cursor = NULL, passNumber = ?, passStartedAt = NULL,
            examinedThisPass = 0, verifiedThisPass = 0,
            lastPassCompletedAt = ?, lastPassExamined = ?, lastPassVerified = ?,
            lastPassBacklog = ?, consecutiveBacklogPasses = ?
      WHERE id = 1`,
  )
    .bind(state.passNumber + 1, Date.now(), totalExamined, totalVerified, backlog, consecutive)
    .run();

  // §A — a full pass is a RECORDED EVENT, not an inference from the absence of errors.
  await audit(env, null, 'vault.scan_pass_complete', null, {
    pass: state.passNumber + 1,
    startedAt: passStartedAt,
    examined: totalExamined,
    verified: totalVerified,
    backlog,
  });

  if (consecutive >= BACKLOG_ALERT_PASSES) {
    // Silent partial coverage was the defect. A cursor that quietly falls behind would
    // reproduce it in a subtler form, so falling behind is itself an alertable condition.
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'vault_scan_backlog',
        message: `vault scan has ended ${consecutive} consecutive passes with unverified objects`,
        backlog,
        pass: state.passNumber + 1,
      }),
    );
    await audit(env, null, 'vault.scan_backlog', null, { consecutive, backlog });
    await operatorAlert(
      env,
      'vault_backlog',
      `vault scan ended ${consecutive} consecutive passes with ${backlog} unverified object(s) — coverage is falling behind`,
    );
  }
}
