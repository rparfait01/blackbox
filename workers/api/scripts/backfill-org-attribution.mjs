#!/usr/bin/env node
/**
 * Brief 23 Fix A §C/§F5 — BACKFILL `orgId` ONTO EVIDENCE, BATCHED AND CURSORED.
 *
 * ═══ WHY THIS IS NOT IN THE MIGRATION ════════════════════════════════════════════════════════
 *
 * 0060 adds columns and indexes and moves no data. The backfill is here because a single
 * `UPDATE chunks_index SET orgId = (SELECT ...)` runs across every row in one statement, and the
 * failure mode is not a clean error — it is a statement that exceeds a D1 limit part-way through,
 * leaving some rows attributed and some not, with nothing recording which.
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
 * ═══ IT REPORTS WHAT IT EXAMINED, NOT ONLY WHAT IT CHANGED ═══════════════════════════════════
 *
 * Standing constraint. "0 changed" and "0 examined" are different facts, and a report that cannot
 * distinguish them is a report that a stalled job is a finished one. Every table prints three
 * numbers — examined, needed, attributed — and the run states its MODE up front:
 *
 *   FULL PASS (default) — the cursor is ignored; every row is considered.
 *   RESUMED (--resume)  — continues from the recorded cursor; rows before it are NOT re-examined.
 *
 * The first version of this script always resumed, so a table marked complete was never scanned
 * again and rows created afterwards whose keys sorted before the cursor were skipped forever. It
 * printed "0 attributed" and exited 0.
 *
 * ═══ WHERE THE PAGING HAPPENS, AND WHY ═══════════════════════════════════════════════════════
 *
 * The cursor pages over CANDIDATES — rows that still need attribution — not over every row. A
 * version that paged the whole table spawned one wrangler process per batch: 34,104 audit rows at
 * 100 per batch is 342 subprocesses and about twenty minutes to write nothing. The WHERE clause
 * examines every row inside D1, which is where that work belongs; the cursor exists to bound each
 * UPDATE statement, not to enumerate a table through a shell.
 *
 * ═══ ATTRIBUTION IS FROZEN (§F2) ═════════════════════════════════════════════════════════════
 *
 * Rows are stamped from the org the owning event was created under. A survivor who later joins or
 * leaves an org does not have her history re-attributed — a grant audit must say which org held
 * custody at the time, not which org she belongs to now. This never overwrites a non-NULL value.
 *
 * Usage:
 *   node scripts/backfill-org-attribution.mjs --env staging [--batch 200] [--dry-run] [--resume]
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
const RESUMING = args.includes('--resume');

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
 * so a non-unique key would skip rows silently. Composite-keyed tables use the full primary key
 * rather than just `eventId`, which is NOT unique on those tables.
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

// Address the BINDING plus --env, not the database name. `wrangler d1 execute blackbox-test`
// resolves against the top-level environment where that database is not bound, and fails with an
// authentication error that looks like a credentials problem rather than a wiring one.
const ENV_ARGS = ENV === 'production' ? ['--env', ''] : ['--env', 'staging'];
const API_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function d1(sql) {
  // Call wrangler's JS entry with node directly. `npx` is `npx.cmd` on Windows, which Node 24
  // refuses to run through execFile without a shell — and a shell would hand cmd.exe SQL full of
  // quotes and parentheses to re-parse, which is how `^{commit}` was eaten in Brief 35.
  const WRANGLER = join(
    dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'DB', ...ENV_ARGS, '--remote', '--json', '--command', sql],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

const esc = (v) => String(v).replace(/'/g, "''");

console.log(`Backfilling org attribution — env=${ENV} batch=${BATCH}${DRY ? ' (DRY RUN)' : ''}`);
console.log(
  RESUMING
    ? 'MODE: RESUMED — continuing from the recorded cursor. Rows before it are NOT re-examined.'
    : 'MODE: FULL PASS — the cursor is ignored; every row is considered.',
);

let grandTotal = 0;
let grandExamined = 0;
const report = [];

for (const t of TABLES) {
  // EXAMINED and NEEDED are counted, not inferred. A table with a million rows and no org has
  // examined = 1,000,000 and attributed = 0, and those must not collapse into one number.
  const examined = Number(d1(`SELECT COUNT(*) AS n FROM ${t.name}`)[0]?.n ?? 0);
  const needed = Number(
    d1(
      `SELECT COUNT(*) AS n FROM ${t.name} WHERE orgId IS NULL AND ${t.fk} IS NOT NULL ` +
        `AND (SELECT orgId FROM ${t.from} WHERE id = ${t.name}.${t.fk}) IS NOT NULL`,
    )[0]?.n ?? 0,
  );

  const progress =
    DRY || !RESUMING
      ? []
      : d1(`SELECT lastKey, rowsWritten FROM org_backfill_progress WHERE tableName = '${t.name}'`);
  let cursor = progress[0]?.lastKey ?? '';
  let written = Number(progress[0]?.rowsWritten ?? 0);
  let batches = 0;

  for (;;) {
    const cursorClause = cursor ? `AND (${t.keyExpr}) > '${esc(cursor)}'` : '';
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
          `AND (${t.keyExpr}) > '${esc(cursor)}' AND (${t.keyExpr}) <= '${esc(last)}'`,
      );
      d1(
        `INSERT INTO org_backfill_progress (tableName, lastKey, rowsWritten, updatedAt) ` +
          `VALUES ('${t.name}', '${esc(last)}', ${written + candidates.length}, ${Date.now()}) ` +
          `ON CONFLICT(tableName) DO UPDATE SET lastKey = excluded.lastKey, ` +
          `rowsWritten = excluded.rowsWritten, updatedAt = excluded.updatedAt`,
      );
    }
    cursor = last;
    written += candidates.length;
    batches += 1;
  }

  if (!DRY) {
    d1(
      `INSERT INTO org_backfill_progress (tableName, lastKey, rowsWritten, completedAt, updatedAt) ` +
        `VALUES ('${t.name}', ${cursor ? `'${esc(cursor)}'` : 'NULL'}, ${written}, ${Date.now()}, ${Date.now()}) ` +
        `ON CONFLICT(tableName) DO UPDATE SET completedAt = excluded.completedAt, ` +
        `rowsWritten = excluded.rowsWritten, updatedAt = excluded.updatedAt`,
    );
  }

  const leftNull = Number(d1(`SELECT COUNT(*) AS n FROM ${t.name} WHERE orgId IS NULL`)[0]?.n ?? 0);
  report.push({ table: t.name, examined, needed, attributed: written, leftNull, batches });
  grandTotal += written;
  grandExamined += examined;
  console.log(
    `  ${t.name}: examined ${examined}, needed ${needed}, attributed ${written}, ` +
      `${leftNull} left NULL (correct) — ${batches} batch(es)`,
  );
}

console.log(
  `\n${grandExamined} row(s) EXAMINED, ${grandTotal} attributed, across ${TABLES.length} tables ` +
    `(${RESUMING ? 'RESUMED' : 'FULL PASS'}).`,
);
console.log('Rows left NULL are UNAFFILIATED — that is their correct and final value, not pending work.');
console.table(report);
