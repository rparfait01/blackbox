import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Brief 53 §B — THE ANONYMOUS TALLY IS SEVERED, AND A MIGRATION MAY NOT RE-ATTACH IT.
 *
 * ═══ WHAT SEVERANCE MEANS HERE ════════════════════════════════════════════════════════════════
 *
 * `incident_tally` records THAT an incident occurred, never what happened and never to whom. It
 * holds four closed-vocabulary answers and a submission MONTH. There is no account column, no
 * device, no session, no event, no capture, no foreign key, and no free text — not because a
 * policy forbids reading them, but because there is nothing in the row to read.
 *
 * That is the whole design: a survivor's willingness to be counted cannot depend on trusting a
 * promise about access control, because she has no way to audit one. It depends on the row being
 * incapable of identifying her.
 *
 * ═══ WHY A GUARD AND NOT A COMMENT ════════════════════════════════════════════════════════════
 *
 * 0032 already carries a comment saying "NO free-text column — not optional, not hidden, not
 * 'notes'". A comment records an intention; it does not survive a later migration written by
 * someone solving a different problem in a hurry. Every re-identification route into this table
 * is one `ALTER TABLE` away, and each looks locally reasonable at the time:
 *
 *   an account column  — "so we can rate-limit properly"     (the counter belongs on the ACCOUNT)
 *   an orgId           — "for the shelter's dashboard"        (this is not evidence, not tenant data)
 *   a free-text field  — "so she can add context"             (free text is identifying by nature)
 *   a foreign key      — "for referential integrity"          (integrity to WHAT? nothing links here)
 *   a precise timestamp— "for better analytics"               (the instant correlates to an event)
 *
 * ═══ PARSED SCHEMA, NOT SOURCE TEXT — AND THIS TABLE PROVES WHY ═══════════════════════════════
 *
 * A grep for "notes" in 0032 MATCHES — on the comment explaining that no such column exists. A
 * text-matching guard would report the defect it was written to prevent, on the very migration
 * that is correct. Comments are stripped and the column list is parsed.
 */

const TABLE = 'incident_tally';

/** The four closed-vocabulary answers plus the month and the unlinked id. Nothing else. */
const PERMITTED_COLUMNS = new Set([
  'id',
  'kind',
  'roughlyWhen',
  'regionId',
  'reportedOfficial',
  'submissionMonth',
]);

/** Column names that would re-attach the row to a person, an org, or a moment. */
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/user|account|owner|subject/i, 'links the record to an account'],
  [/device|session|token/i, 'links the record to a device or session'],
  [/event|capture|chunk|incidentid/i, 'links the record to an incident record'],
  [/^orgid$|tenant/i, 'attributes the record to a tenant — it is not evidence and not tenant data'],
  [/note|comment|detail|description|freetext|message|text$|body/i, 'free text is identifying by nature'],
  [/timestamp|createdat|submittedat|_at$|instant|epoch/i, 'a precise instant correlates to an event; the month is the resolution'],
  [/lat|lon|coord|address|postcode|zip/i, 'finer than region is re-identifying'],
];

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

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

interface Finding {
  migration: string;
  column: string;
  detail: string;
}

/** Every column the migrations give `incident_tally`, however it is added. */
function tallyColumns(): { columns: Array<{ name: string; migration: string }>; foreignKeys: Finding[] } {
  const columns: Array<{ name: string; migration: string }> = [];
  const foreignKeys: Finding[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8'));

    const createRe = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE}\\s*\\(([\\s\\S]*?)\\n\\s*\\)\\s*;`,
      'gi',
    );
    for (const m of sql.matchAll(createRe)) {
      for (const def of splitTopLevel(m[1])) {
        const trimmed = def.trim();
        if (/^(FOREIGN\s+KEY|REFERENCES|CONSTRAINT)/i.test(trimmed) || /\bREFERENCES\b/i.test(trimmed)) {
          foreignKeys.push({ migration: file, column: trimmed.slice(0, 60), detail: 'foreign key' });
        }
        const nameMatch = /^([A-Za-z_][\w]*)\s+/.exec(trimmed);
        if (!nameMatch) continue;
        if (['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(nameMatch[1].toUpperCase())) continue;
        columns.push({ name: nameMatch[1], migration: file });
      }
    }

    const alterRe = new RegExp(
      `ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+(?:COLUMN\\s+)?([A-Za-z_][\\w]*)([^;]*);`,
      'gi',
    );
    for (const m of sql.matchAll(alterRe)) {
      columns.push({ name: m[1], migration: file });
      if (/\bREFERENCES\b/i.test(m[2])) {
        foreignKeys.push({ migration: file, column: m[1], detail: 'foreign key added by ALTER' });
      }
    }
  }
  return { columns, foreignKeys };
}

describe('Brief 53 §B — the anonymous tally stays severed', () => {
  const { columns, foreignKeys } = tallyColumns();

  it('found the table — this guard asserts its own landmarks', () => {
    // A regex that matched nothing would make every assertion below pass over an empty list.
    expect(columns.length, `no ${TABLE} columns parsed — the guard is reading nothing`).toBeGreaterThan(4);
    expect(columns.map((c) => c.name), 'the month column is missing — wrong table?').toContain('submissionMonth');
  });

  it('does not match the COMMENT that says there is no free-text column', () => {
    // 0032 contains the word "notes" inside a comment explaining its own absence. A text-matching
    // guard reports a defect here; a parsing one does not. This pins that difference.
    const raw = readFileSync(join(MIGRATIONS, '0032_incident_tally.sql'), 'utf8');
    expect(raw, 'the fixture for this test has changed — 0032 no longer mentions notes').toMatch(/notes/i);
    expect(
      columns.map((c) => c.name).filter((n) => /note/i.test(n)),
      'a comment was parsed as a column',
    ).toEqual([]);
  });

  it('carries NO foreign key — there is nothing for this row to reference', () => {
    expect(foreignKeys, `${TABLE} gained a foreign key`).toEqual([]);
  });

  it('carries only the permitted columns — nothing that re-attaches it to a person', () => {
    const findings: Finding[] = [];
    for (const col of columns) {
      if (PERMITTED_COLUMNS.has(col.name)) continue;
      const matched = FORBIDDEN_PATTERNS.find(([re]) => re.test(col.name));
      findings.push({
        migration: col.migration,
        column: col.name,
        detail: matched
          ? matched[1]
          : 'not in the permitted set — every column here must be justified against re-identification',
      });
    }
    expect(
      findings.map((f) => `${f.migration}: ${TABLE}.${f.column} — ${f.detail}`),
      'A migration added a column to the anonymous tally. This store is severed BY CONSTRUCTION: ' +
        'a survivor consents to being counted because the row cannot identify her, not because a ' +
        'policy says nobody will look. If the column is genuinely non-identifying, add it to ' +
        'PERMITTED_COLUMNS with the reasoning written down.',
    ).toEqual([]);
  });

  it('the Brief 23 Fix A attribution migration deliberately skipped this table', () => {
    // §B2.2 — the tally gets no orgId and no tenant attribution of any kind. It is not evidence
    // and it is not anyone's tenant data. 0060 attributed ten evidence tables and not this one.
    const attribution = readFileSync(join(MIGRATIONS, '0060_org_attribution.sql'), 'utf8');
    expect(attribution, '0060 touched the anonymous tally').not.toContain(TABLE);
  });
});
