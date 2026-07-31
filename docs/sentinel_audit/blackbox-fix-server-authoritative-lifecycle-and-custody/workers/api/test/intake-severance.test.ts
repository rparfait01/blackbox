import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeIntakeStat } from '../src/lib/intake-stats';

/**
 * Brief 27 §5 — the anonymized export's severance is HARDER than the tally's because the
 * source is identified (a case file). These grep-prove there is NO join path, NO shared
 * id, and NO correlatable timestamp between a case file and its anonymized export — and
 * that suppression is the ONE shared implementation, not a second (weaker) copy.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, '..', p), 'utf8');

describe('§5 the intake_stats store is severed (no join to identified data)', () => {
  const migration = read('migrations/0036_case_files.sql');
  const table = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS intake_stats'));

  it('the intake_stats row has NO userId, caseFileId, event/capture link', () => {
    for (const forbidden of [/userId/i, /caseFileId/i, /case_file/i, /eventId/i, /deviceId/i]) {
      expect(table, `intake_stats must not carry ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('the row records only the submission MONTH — no correlatable precise timestamp', () => {
    expect(table).toMatch(/submissionMonth/);
    // A precise instant would correlate the export with the case file's createdAt.
    expect(table).not.toMatch(/createdAt|timestamp|filedAt|\bat INTEGER\b/i);
  });

  it('there is no free-text column', () => {
    // (exclude the SQL type keyword TEXT — the forbidden thing is a free-text FIELD)
    expect(table).not.toMatch(/\b(narrative|notes?|description|freetext|free_text|message|body)\b/i);
  });
});

describe('§5 the module never links the export to identity, and shares suppression', () => {
  // Strip comments: the module's own severance disclaimer names case_files/events in prose.
  const lib = read('src/lib/intake-stats.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('the INSERT binds no userId/caseFileId and uses the coarse month only', () => {
    expect(lib).toMatch(/INSERT INTO intake_stats \(id, incidentTypeId, whenRange, regionId, relationshipId, reportedToAuthorities, submissionMonth\)/);
    const insert = lib.slice(lib.indexOf('INSERT INTO intake_stats'), lib.indexOf('.run()', lib.indexOf('INSERT INTO intake_stats')) + 10);
    expect(insert).not.toMatch(/userId|caseFileId|Date\.now/);
  });

  it('it never reads or joins case_files or any identified table', () => {
    expect(lib).not.toMatch(/case_files|FROM events|JOIN /i);
  });

  it('publication uses the SHARED suppression, not a second implementation', () => {
    expect(lib).toMatch(/suppressedAggregate\(env, 'intake_stats'/);
    expect(lib).not.toMatch(/HAVING COUNT/); // no local suppression query
  });

  it('normalizeIntakeStat admits only closed values — no free text can enter', () => {
    const out = normalizeIntakeStat({
      incidentTypeId: 'threats_intimidation',
      reportedToAuthorities: 'a long free-text answer that is not a closed value',
      narrative: 'this should be ignored entirely',
    });
    expect(out.reportedToAuthorities).toBeNull(); // not in the closed set → dropped
    expect(out).not.toHaveProperty('narrative'); // free text has no field to land in
    expect(out.incidentTypeId).toBe('threats_intimidation');
  });
});

describe('§5 Destination 3 (org intake) is NOT built — no auto-submit path exists', () => {
  it('case_files carry no org association', () => {
    const migration = read('migrations/0036_case_files.sql');
    const cf = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS case_files'), migration.indexOf('CREATE TABLE IF NOT EXISTS intake_stats'));
    expect(cf).not.toMatch(/orgId|org_id/i);
  });
  it('no endpoint forwards or auto-submits a case file to an org', () => {
    const caseFiles = read('src/lib/case-files.ts');
    const userRoutes = read('src/routes/user.ts');
    // The case-file lib touches only the owner's case_files — never org tables.
    expect(caseFiles).not.toMatch(/org_members|organizations|orgId|forward|auto.?submit/i);
    // No route sends a case file anywhere on the survivor's behalf.
    expect(userRoutes).not.toMatch(/case.?file[\s\S]{0,60}(org|forward|submit.?to)/i);
  });
});
