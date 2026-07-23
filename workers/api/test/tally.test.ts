import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeSubmission,
  rateDecision,
  submissionMonth,
  SUPPRESSION_THRESHOLD,
  TALLY_MONTHLY_LIMIT,
} from '../src/lib/tally';

/**
 * Brief 25 — Anonymous Incident Tally. Severance is the paramount property: the store
 * holds no identity, no free text, and no link to any account/device/event. These
 * pin the pure rules AND assert the severance at the schema + module level.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, '..', p), 'utf8');

describe('§2 the form accepts ONLY closed vocabulary — no free text ever reaches the store', () => {
  it('unknown / arbitrary strings are coerced to null, never stored verbatim', () => {
    const out = normalizeSubmission({
      kind: 'he grabbed me at the office party', // free text → dropped
      roughlyWhen: 'last Tuesday 9pm', // finer-than-allowed → dropped
      reportedOfficial: 'sort of',
    });
    expect(out).toEqual({ kind: null, roughlyWhen: null, reportedOfficial: null });
  });

  it('accepts the exact enum values', () => {
    const out = normalizeSubmission({
      kind: 'domestic_violence',
      roughlyWhen: 'past_year',
      reportedOfficial: 'no',
    });
    expect(out).toEqual({ kind: 'domestic_violence', roughlyWhen: 'past_year', reportedOfficial: 'no' });
  });

  it('a skipped question is null (every question is skippable)', () => {
    expect(normalizeSubmission({})).toEqual({ kind: null, roughlyWhen: null, reportedOfficial: null });
  });
});

describe('§3 submission time is a MONTH only — never a precise instant', () => {
  it('formats YYYY-MM in UTC', () => {
    expect(submissionMonth(Date.UTC(2026, 6, 24, 13, 45, 12))).toBe('2026-07');
    expect(submissionMonth(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01');
  });
});

describe('§4 rate limit — per account, honest, resets monthly', () => {
  it('allows up to the monthly limit, then refuses', () => {
    expect(rateDecision({ tallyMonth: '2026-07', tallyCount: 0 }, '2026-07')).toEqual({ allowed: true, nextCount: 1 });
    expect(rateDecision({ tallyMonth: '2026-07', tallyCount: TALLY_MONTHLY_LIMIT - 1 }, '2026-07')).toEqual({
      allowed: true,
      nextCount: TALLY_MONTHLY_LIMIT,
    });
    expect(rateDecision({ tallyMonth: '2026-07', tallyCount: TALLY_MONTHLY_LIMIT }, '2026-07')).toEqual({
      allowed: false,
      used: TALLY_MONTHLY_LIMIT,
      limit: TALLY_MONTHLY_LIMIT,
    });
  });

  it('a new month resets the count', () => {
    expect(rateDecision({ tallyMonth: '2026-06', tallyCount: TALLY_MONTHLY_LIMIT }, '2026-07')).toEqual({
      allowed: true,
      nextCount: 1,
    });
  });
});

describe('§3 SEVERANCE — the store carries no identity and no link', () => {
  const migration = read('migrations/0032_incident_tally.sql');
  const lib = read('src/lib/tally.ts');

  it('the incident_tally table has NONE of: userId, deviceId, ip, session, pushToken, orgId', () => {
    const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('ALTER TABLE'));
    for (const forbidden of [/userId/i, /deviceId/i, /\bip\b/i, /session/i, /pushToken/i, /orgId/i]) {
      expect(table, `incident_tally must not carry ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('the store has NO free-text column (no notes/text/description/comment)', () => {
    const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('ALTER TABLE'));
    expect(table).not.toMatch(/\b(notes?|description|comment|freetext|detail|message|body)\b/i);
  });

  it('the store keeps only the submission MONTH, never a precise timestamp column', () => {
    const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('ALTER TABLE'));
    expect(table).toMatch(/submissionMonth/);
    expect(table).not.toMatch(/createdAt|timestamp|submittedAt|\bat INTEGER\b/i);
  });

  it('the INSERT binds no account/identity column — only the four answers + month', () => {
    // The insert column list is exactly these six; userId/orgId/device never appear.
    expect(lib).toMatch(/INSERT INTO incident_tally \(id, kind, roughlyWhen, regionId, reportedOfficial, submissionMonth\)/);
    const insertStmt = lib.slice(lib.indexOf('INSERT INTO incident_tally'), lib.indexOf('.bind', lib.indexOf('INSERT INTO incident_tally')) + 200);
    expect(insertStmt).not.toMatch(/userId|orgId|device/i);
  });
});

describe('§1 NO derivation — the module never reads or joins capture/event data', () => {
  const lib = read('src/lib/tally.ts');
  it('touches only incident_tally and the users rate-limit columns — no events/captures/chunks/locations', () => {
    expect(lib).not.toMatch(/FROM events|FROM chunks|FROM locations|FROM classifications|FROM transcripts|JOIN events/i);
    // The only users columns it reads/writes are the rate-limit counter.
    expect(lib).toMatch(/SELECT tallyMonth, tallyCount FROM users/);
  });
});

describe('§6 publication — suppressed aggregates, threshold is the default', () => {
  const lib = read('src/lib/tally.ts');
  it('suppresses cells below the threshold via HAVING COUNT(*) >= threshold', () => {
    expect(SUPPRESSION_THRESHOLD).toBeGreaterThanOrEqual(10);
    expect(lib).toMatch(/HAVING COUNT\(\*\) >= \?/);
  });
  it('publishes grouped counts, never individual rows (GROUP BY the coarse fields)', () => {
    expect(lib).toMatch(/GROUP BY submissionMonth, regionId, kind, roughlyWhen, reportedOfficial/);
  });
});
