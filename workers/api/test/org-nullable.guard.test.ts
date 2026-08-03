import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Brief 23 Fix A §B — `orgId` IS NULLABLE, AND A MIGRATION MAY NOT TAKE THAT AWAY.
 *
 * ═══ WHAT THIS IS PROTECTING ══════════════════════════════════════════════════════════════════
 *
 * An organization is OPTIONAL. A survivor who bought BLACK BOX on Gumroad belongs to no shelter,
 * no coalition, no org, and that is a first-class supported state — not a gap, not a row awaiting
 * a backfill. Every production row is NULL today.
 *
 * A prior draft of Brief 23 Fix A proposed `orgId NOT NULL` after backfill. It was struck, because
 * it would have forced every consumer into an organization to satisfy a schema. This guard is what
 * stops that idea coming back as a one-line migration nobody reads closely — the failure would not
 * be a broken build, it would be a survivor placed inside an institution she never joined.
 *
 * ═══ THE DISTINCTION THE GUARD ENCODES ════════════════════════════════════════════════════════
 *
 * NOT every `orgId` may be null. Two kinds of table carry the column and they are opposites:
 *
 *   TENANCY-BEARING — users, events, and the evidence tables. The row belongs to a person. It may
 *                     belong to an org, or to no org. NULL is a MEANING here: unaffiliated.
 *                     `NOT NULL` is forbidden.
 *
 *   ORG-STRUCTURAL  — org_members, enrollment_codes, org_licenses, org_key_grants,
 *                     admin_registration_codes. The row exists ONLY to bind something to an org.
 *                     A membership in no org, or an enrollment code that enrols into nothing, is
 *                     not a supported state — it is a corrupt row. `NOT NULL` is REQUIRED, and
 *                     this guard asserts it rather than merely tolerating it, so the unsafe state
 *                     stays unrepresentable in both directions.
 *
 * NOTE ON THE BRIEF. Brief 23 Fix A's correction reads "`orgId` remains nullable on `users`,
 * `events`, and `enrollment_codes`". `enrollment_codes.orgId` has been NOT NULL since 0031 and
 * should stay that way for the reason above; the principle is about accounts, events and evidence.
 * Recorded here rather than silently resolved either way.
 *
 * ═══ PARSED SCHEMA, NOT SOURCE TEXT ═══════════════════════════════════════════════════════════
 *
 * Per the standing rule. The migrations are parsed into a column model — CREATE TABLE bodies split
 * into column definitions, plus ALTER TABLE ADD COLUMN — and the assertions run against that. A
 * grep for "NOT NULL" would match a comment explaining why something is nullable, which is the
 * exact prose-matching failure the rule exists for.
 */

/** Tables whose `orgId` must be NOT NULL: the row has no meaning without an org. */
const ORG_STRUCTURAL = new Set([
  'org_members',
  'enrollment_codes',
  'org_licenses',
  'org_key_grants',
  'admin_registration_codes',
]);

interface Column {
  table: string;
  name: string;
  notNull: boolean;
  migration: string;
}

/** Strip SQL comments so a definition is never read out of prose. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Split a CREATE TABLE body on top-level commas only. A naive `.split(',')` breaks
 * `CHECK (role IN ('a','b'))` into fragments and silently loses the column that follows.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseColumns(): Column[] {
  const columns: Column[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8'));

    // CREATE TABLE [IF NOT EXISTS] <name> ( ... );
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    for (const m of sql.matchAll(createRe)) {
      const table = m[1];
      for (const def of splitTopLevel(m[2])) {
        const trimmed = def.trim();
        const nameMatch = /^([A-Za-z_][\w]*)\s+/.exec(trimmed);
        if (!nameMatch) continue; // a table-level constraint, not a column
        const keyword = nameMatch[1].toUpperCase();
        if (['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(keyword)) continue;
        columns.push({
          table,
          name: nameMatch[1],
          notNull: /\bNOT\s+NULL\b/i.test(trimmed),
          migration: file,
        });
      }
    }

    // ALTER TABLE <name> ADD COLUMN <col> <type...>;
    const alterRe = /ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+([A-Za-z_][\w]*)([^;]*);/gi;
    for (const m of sql.matchAll(alterRe)) {
      columns.push({
        table: m[1],
        name: m[2],
        notNull: /\bNOT\s+NULL\b/i.test(m[3]),
        migration: file,
      });
    }
  }
  return columns;
}

describe('Brief 23 Fix A §B — orgId nullability', () => {
  const columns = parseColumns();
  const orgIdColumns = columns.filter((c) => c.name === 'orgId');

  it('parsed the migrations — this guard asserts its own landmarks', () => {
    // Without this, a parser that silently matched nothing would make every assertion below pass
    // over an empty list, which is the vacuous shape the fixture sweep exists to catch.
    expect(columns.length, 'no columns parsed at all — the DDL parser is broken').toBeGreaterThan(100);
    expect(orgIdColumns.length, 'no orgId columns found — the parser missed the tenancy schema').toBeGreaterThan(4);

    // The two anchors the whole brief rests on must be among what was parsed.
    const tables = new Set(orgIdColumns.map((c) => c.table));
    expect(tables, 'users.orgId not found by the parser').toContain('users');
    expect(tables, 'events.orgId not found by the parser').toContain('events');
  });

  it('the parser reads CHECK constraints without losing the columns after them', () => {
    // `CHECK (role IN ('survivor','coordinator','admin'))` contains commas. A top-level split is
    // what stops those commas eating the column definitions that follow.
    const roleRow = columns.filter((c) => c.table === 'enrollment_codes').map((c) => c.name);
    expect(roleRow, 'columns after a CHECK constraint were lost').toContain('createdAt');
  });

  it('NO tenancy-bearing orgId column is NOT NULL — an unaffiliated account is supported', () => {
    const offenders = orgIdColumns.filter((c) => !ORG_STRUCTURAL.has(c.table) && c.notNull);
    expect(
      offenders.map((o) => `${o.migration}: ${o.table}.orgId`),
      'A migration made orgId NOT NULL on a tenancy-bearing table. That forces every unaffiliated ' +
        'survivor into an organization to satisfy a schema. If the table genuinely cannot exist ' +
        'without an org, add it to ORG_STRUCTURAL and say why.',
    ).toEqual([]);
  });

  it('users.orgId and events.orgId are nullable, named explicitly', () => {
    for (const table of ['users', 'events']) {
      const col = orgIdColumns.find((c) => c.table === table);
      expect(col, `${table}.orgId is missing entirely`).toBeDefined();
      expect(col!.notNull, `${table}.orgId is NOT NULL — an unaffiliated account cannot exist`).toBe(false);
    }
  });

  it('org-structural orgId columns ARE NOT NULL — the unsafe state is unrepresentable both ways', () => {
    // The mirror of the rule above. A membership row or an enrollment code with no org is not an
    // "unaffiliated" anything; it is a corrupt row that would enrol someone into nothing.
    for (const table of ORG_STRUCTURAL) {
      const col = orgIdColumns.find((c) => c.table === table);
      if (!col) continue; // the table may not exist yet; §C does not create these
      expect(col.notNull, `${table}.orgId is nullable — a row there without an org is meaningless`).toBe(true);
    }
  });
});
