import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BACKLOG_ALERT_PASSES, SCAN_BATCH } from '../src/lib/vault-scan';

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/**
 * Brief 40 §A — coverage is proven by a cursor, not asserted by a job that ran.
 *
 * THE DEFECT. `runIntegrityScan` read `ORDER BY sealedAt ASC LIMIT 50` with no cursor, so
 * every run re-examined the same fifty rows. Past fifty eligible objects the tail was never
 * reached — and the job still completed, logged nothing unusual, and reported no coverage
 * figure at all. The vault was a naming convention with a scan that looked healthy.
 *
 * Worth recording because it changes what the alert must watch: with `sealedAt ASC` the
 * starved objects were the NEWEST, not the oldest. The backlog therefore grows at the new
 * end, which is why coverage counts objects whose verification predates the current pass
 * rather than counting age.
 */
describe('§A the capped scan is gone', () => {
  const scan = read('lib/vault-scan.ts');
  const integrity = read('lib/integrity.ts');

  it('no capped re-read of the same head', () => {
    const code = integrity.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/ORDER BY sealedAt ASC LIMIT/);
    // The old scan body moved out entirely; integrity.ts only delegates.
    expect(code).toMatch(/await runVaultScan\(env, workerOrigin\)/);
  });

  it('the cursor walks the PRIMARY KEY, so no row is skipped or repeated', () => {
    // sealedAt can tie, and a tie makes a cursor skip or repeat. vaultKey is the primary key.
    expect(scan).toMatch(/vaultKey > \?/);
    expect(scan).toMatch(/ORDER BY vaultKey ASC LIMIT \?/);
  });

  it('a pass completes only when the batch runs short, and resets the cursor', () => {
    expect(scan).toMatch(/const passComplete = batch\.length < SCAN_BATCH;/);
    expect(scan).toMatch(/SET cursor = NULL/);
  });

  it('the cursor advances past an object that FAILED, so one bad object cannot wedge the pass', () => {
    expect(scan).toMatch(/lastKey = row\.vaultKey;/);
    const loopEnd = scan.indexOf('const passComplete');
    const loop = scan.slice(scan.indexOf('for (const row of batch)'), loopEnd);
    // No `continue` that would skip the cursor advance — that is how the old code left the
    // head un-advanced on a missing object.
    expect(loop).not.toMatch(/\bcontinue;/);
  });

  it('the batch stays small — the 20s job bound is not to be spent here', () => {
    // Brief 36 §11 bounded every cron job because an overrun silently starves the jobs
    // behind it. The cursor exists so a bounded job and full coverage are compatible; raising
    // this instead would trade one silent failure for another.
    expect(SCAN_BATCH).toBeLessThanOrEqual(50);
    const cron = readFileSync(new URL('../src/scheduled.ts', import.meta.url), 'utf8');
    expect(cron).toMatch(/boundedJob\('integrity'/);
    expect(cron).toMatch(/JOB_TIMEOUT_MS = 20_000/);
  });
});

describe('§A a full pass is recorded, and falling behind is alertable', () => {
  const scan = read('lib/vault-scan.ts');

  it('a completed pass writes an event with what it examined', () => {
    expect(scan).toMatch(/'vault\.scan_pass_complete'/);
    expect(scan).toMatch(/examined: totalExamined/);
    expect(scan).toMatch(/verified: totalVerified/);
  });

  it('backlog is measured against the PASS START, not against age', () => {
    expect(scan).toMatch(/lastVerifiedAt IS NULL OR lastVerifiedAt < \?/);
  });

  it('sustained backlog raises an operator alert at error level', () => {
    // Silent partial coverage was the defect. A cursor that quietly falls behind reproduces
    // it in a subtler form, so falling behind is itself alertable.
    expect(BACKLOG_ALERT_PASSES).toBeGreaterThanOrEqual(2);
    expect(scan).toMatch(/consecutive >= BACKLOG_ALERT_PASSES/);
    expect(scan).toMatch(/alert: 'vault_scan_backlog'/);
    expect(scan).toMatch(/level: 'error'/);
  });

  it('coverage is reported by the readiness panel, counted from the tables', () => {
    const index = read('index.ts');
    expect(index).toMatch(/const vault = await vaultCoverage\(c\.env\)/);
    expect(index).toMatch(/objects verified/);
  });
});

describe('§D the retention claim is bounded in code, not implied', () => {
  it('the panel states plainly that no storage-layer rule exists yet', () => {
    // Brief 38 §B set the precedent: bound the claim in code rather than letting wording
    // imply more than the design delivers. No lock is provisioned (Brief 40 §0 is unsigned),
    // so the panel says so rather than letting "vault" imply retention.
    const index = read('index.ts');
    expect(index).toMatch(/retentionRule: 'NOT PROVISIONED/);
  });

  it('no document in the repo claims write-once while §0 is unresolved', () => {
    // The corrections forbid the phrase until this brief is green.
    const spec = readFileSync(new URL('../../../docs/STANDING_CONSTRAINTS.md', import.meta.url), 'utf8');
    expect(spec.toLowerCase()).not.toContain('write-once');
  });
});
