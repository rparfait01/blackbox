#!/usr/bin/env node
/**
 * Brief 23 Fix A §C/§F5 — BACKFILL `orgId` ONTO EVIDENCE, BATCHED AND CURSORED.
 *
 * ═══ WHY THIS IS NOT IN THE MIGRATION ════════════════════════════════════════════════════════
 *
 * 0060 adds columns and indexes and moves no data. The backfill is here because a single
 * `UPDATE chunks_index SET orgId = (SELECT ...)` runs across every row in one statement, and the
 * failure mode is not a clean error — it is a statement that exceeds a D1 limit part-way through,
 * leaving some rows attributed and some not, with nothing recording which. §F5 says batched with
 * a cursor; this is that, and the cursor is persisted in `org_backfill_progress` so an
 * interrupted run resumes instead of starting over.
 *
 * ═══ WHAT IT WRITES, AND WHAT IT CORRECTLY DOES NOT ══════════════════════════════════════════
 *
 * A DEFAULT IS NOT A BACKFILL — the rule this codebase has broken twice (0038 silently un-armed
 * every account; 0049 made five closed events report "in progress"). So, explicitly:
 *
 *   Rows whose owning event/account HAS an org      → stamped with that org.
 *   Rows whose owning event/account has NO org      → left NULL. This is the CORRECT AND FINAL
 *                                                     value, not a row awaiting attention.
 *   Rows with no owning event/account at all        → left NULL. Tokenless covert events and
 *                                                     legacy userHash-only contacts are real and
 *                                                     supported; they belong to no org.
 *
 * On PRODUCTION today this run is a no-op by construction: zero organizations exist, every
 * users.orgId and events.orgId is NULL, so there is nothing for any evidence row to be attributed
 * to. It is not skipped on that basis — it is RUN, and it reports 0 rows written, because
 * "I reasoned it would be a no-op" and "I observed it was a no-op" are different claims.
 *
 * ═══ ATTRIBUTION IS FROZEN (§F2) ═════════════════════════════════════════════════════════════
 *
 * Rows are stamped from the org the owning event was created under. A survivor who later joins or
 * leaves an org does not have her history re-attributed — a grant audit must say which org held
 * custody at the time, not which org she belongs to now. Re-running this script is therefore
 * idempotent only while event attribution is unchanged, and it never overwrites a non-NULL value.
 *
 * Usage:
 *   node scripts/backfill-org-attribution.mjs --env staging [--batch 200] [--dry-run]
 *   node scripts/backfill-org-attribution.mjs --env production --confirm
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const ENV = flag('env', 'staging');
const BATCH = Number(flag('batch', 200));
const DRY = args.includes('--dry-run');

if (ENV === 'production' && !args.includes('--confirm')) {
  console.error('Refusing to touch production without --confirm.');
  process.exit(1);
}
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 500) {
  console.error(`--batch must be 1..500 (D1 statement limits); got ${BATCH}`);
  process.exit(1);
}

/**
 * Each table, its cursor key, and where its org comes from.
 *
 * `keyExpr` must be a UNIQUE, ORDERABLE expression — the cursor pages on it with a strict `>`,
 * so a non-unique key would skip rows silently. Composite-keyed tables use a concatenation of
 * the full primary key rather than just `eventId`, which is NOT unique on those tables.
 */
const TABLES = [
  { name: 'chunks_index', keyExpr: "eventId || ':' || sequence", from: 'events', fk: 'eventId' },
  { name: 'integrity_records', keyExpr: "eventId || ':' || seq", from: 'events', fk: 'eventId' },
  { name: 'integrity_heads', keyExpr: 'eventId', from: 'events', fk: 'eventId' },
  { name: 'vault_objects', keyExpr: 'vaultKey', from: 'events', fk: 'eventId' },
  { name: 'custody_transfers', keyExpr: 'id', from: 'events', fk: 'eventId' },
  { name: 'delivery_records', keyExpr: 'id', from: 'events', fk: 'eventId' },
  { name: 'wrapped_keys', keyExpr: 'id', from: 'events', fk: 'eventId' },
  { name: 'plaintext_commitments', keyExpr: "eventId || ':' || sequence", from: 'events', fk: 'eventId' },
  { name: 'audit_log', keyExpr: 'id', from: 'events', fk: 'eventId' },
  { name: 'contacts', keyExpr: 'id', from: 'users', fk: 'userId' },
];

const DB = ENV === 'production' ? 'blackbox' : 'blackbox-test';

function d1(sql) {
  // Call wrangler's JS entry with node directly. `npx` is `npx.cmd` on Windows, which Node 24
  // refuses to run through execFile without a shell — and a shell would hand cmd.exe SQL full of
  // quotes and parentheses to re-parse, which is how `^{commit}` was eaten in Brief 35. This form
  // has neither problem and does not depend on PATH.
  // `require.resolve('wrangler/bin/wrangler.js')` fails — the package's "exports" map does not
  // expose the bin path. Resolve the package root through its package.json and join.
  const WRANGLER = join(
    dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

console.log(`Backfilling org attribution — env=${ENV} db=${DB} batch=${BATCH}${DRY ? ' (DRY RUN)' : ''}`);

let grandTotal = 0;
const report = [];

for (const t of TABLES) {
  // Resume from a recorded cursor if a previous run was interrupted.
  // ═══ THE CURSOR IS FOR RESUMING AN INTERRUPTED RUN, NOT FOR SKIPPING A NEW ONE ═════════════
  //
  // This defaults to a FULL PASS and only resumes when asked. The first version always resumed
  // from the recorded cursor, and the isolation pass caught what that means: a table marked
  // complete is never scanned again, so rows created AFTERWARDS whose keys sort before the
  // cursor are skipped forever — and the run reports "0 attributed" and exits 0, which reads as
  // "nothing to do" rather than "I did not look". Silent under-attribution on an operations
  // surface an institutional contract depends on.
  //
  // A full pass is cheap and idempotent: the UPDATE only touches rows that are still NULL and
  // whose owner actually has an org, so re-running attributes exactly the rows that need it.
  const RESUME = args.includes('--resume');
  const progress = DRY || !RESUME
    ? []
    : d1(`SELECT lastKey, rowsWritten FROM org_backfill_progress WHERE tableName = '${t.name}'`);
  let cursor = progress[0]?.lastKey ?? '';
  let written = Number(progress[0]?.rowsWritten ?? 0);
  let batches = 0;

  for (;;) {
    // Page over rows that still need attribution AND whose owner actually has an org. Rows whose
    // owner has no org are simply never selected — they keep NULL, which is their correct value.
    const cursorClause = cursor ? `AND (${t.keyExpr}) > '${cursor.replace(/'/g, "''")}'` : '';
    const candidates = d1(
      `SELECT (${t.keyExpr}) AS k FROM ${t.name} ` +
        `WHERE orgId IS NULL AND ${t.fk} IS NOT NULL ` +
        `AND (SELECT orgId FROM ${t.from} WHERE id = ${t.name}.${t.fk}) IS NOT NULL ` +
        `${cursorClause} ORDER BY (${t.keyExpr}) LIMIT ${BATCH}`,
    );
    if (candidates.length === 0) break;

    const last = String(candidates[candidates.length - 1].k);
    if (!DRY) {
      d1(
        `UPDATE ${t.name} SET orgId = (SELECT orgId FROM ${t.from} WHERE id = ${t.name}.${t.fk}) ` +
          `WHERE orgId IS NULL AND ${t.fk} IS NOT NULL ` +
          `AND (${t.keyExpr}) > '${cursor.replace(/'/g, "''")}' AND (${t.keyExpr}) <= '${last.replace(/'/g, "''")}'`,
      );
      d1(
        `INSERT INTO org_backfill_progress (tableName, lastKey, rowsWritten, updatedAt) ` +
          `VALUES ('${t.name}', '${last.replace(/'/g, "''")}', ${written + candidates.length}, ${Date.now()}) ` +
          `ON CONFLICT(tableName) DO UPDATE SET lastKey = excluded.lastKey, ` +
          `rowsWritten = excluded.rowsWritten, updatedAt = excluded.updatedAt`,
      );
    }
    cursor = last;
    written += candidates.length;
    batches += 1;
    process.stdout.write(`  ${t.name}: ${written} row(s) in ${batches} batch(es)\r`);
  }

  if (!DRY) {
    d1(
      `INSERT INTO org_backfill_progress (tableName, lastKey, rowsWritten, completedAt, updatedAt) ` +
        `VALUES ('${t.name}', ${cursor ? `'${cursor.replace(/'/g, "''")}'` : 'NULL'}, ${written}, ${Date.now()}, ${Date.now()}) ` +
        `ON CONFLICT(tableName) DO UPDATE SET completedAt = excluded.completedAt, updatedAt = excluded.updatedAt`,
    );
  }

  // What was DELIBERATELY left alone, counted rather than assumed.
  const leftNull = d1(`SELECT COUNT(*) AS n FROM ${t.name} WHERE orgId IS NULL`);
  const n = Number(leftNull[0]?.n ?? 0);
  report.push({ table: t.name, attributed: written, leftNull: n, batches });
  grandTotal += written;
  console.log(`  ${t.name}: ${written} attributed in ${batches} batch(es), ${n} correctly left NULL   `);
}

console.log(`\n${grandTotal} row(s) attributed across ${TABLES.length} tables.`);
console.log('Rows left NULL are UNAFFILIATED — that is their correct and final value, not pending work.');
console.table(report);
