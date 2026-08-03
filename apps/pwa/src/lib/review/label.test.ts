import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { formatEvidenceLabel } from '@blackbox/shared';

const SHARED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'packages', 'shared', 'src');

/**
 * The name a survivor sees on her own sealed recording. It replaces the stored identifier, so
 * it has to be both recognisable to her and stable wherever she opens it.
 */

// 2026-07-30T05:32:00Z
const UTC = Date.UTC(2026, 6, 30, 5, 32, 0);

describe('the evidence label', () => {
  it('renders DDMMMYY@HH:MM', () => {
    expect(formatEvidenceLabel(UTC, 0)).toBe('30JUL26@05:32');
  });

  it('uses the EVENT’s local time, not the reader’s', () => {
    // JST is -540 in the getTimezoneOffset convention: 05:32Z is 14:32 local.
    expect(formatEvidenceLabel(UTC, -540)).toBe('30JUL26@14:32');
  });

  it('is identical on every device — the label does not drift with the reviewer’s zone', () => {
    // THIS TEST USED TO BE VACUOUS. It called the function twice with IDENTICAL arguments in one
    // process and asserted the results matched, which is true of any pure function and of most
    // impure ones. It could not fail, so it reported confidence it had not earned — the §D class,
    // found by this brief's own fixture sweep.
    //
    // The property is host-zone independence, and it is established by the implementation reading
    // UTC getters off a pre-shifted instant. A unit test cannot change the host zone (Node reads
    // TZ once at startup), so the property is asserted STRUCTURALLY against the source: any
    // local-time getter would make the output depend on the reviewer's machine.
    const src = readFileSync(join(SHARED, 'time.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function formatEvidenceLabel'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body.length, 'formatEvidenceLabel not found — this guard is looking at nothing').toBeGreaterThan(50);
    // Every date component must come from a UTC getter.
    expect(body).toMatch(/getUTC/);
    // And none may come from a local one. `getDate`/`getHours`/`getMonth`/`getFullYear` without
    // the UTC infix read the HOST zone, which is precisely the drift this claims not to have.
    // An EXPLICIT match result rather than `.not.toMatch(...)`.
    //
    // The first version of this guard did not fail when a local getter was injected into the
    // source it reads — it was replacing a vacuous test and was vacuous itself. I could not
    // establish why: a targeted probe showed `expect(value, message).not.toMatch(re)` asserts
    // correctly in isolation, so the obvious explanation is wrong and the real one is unknown.
    // Rather than ship a guard whose behaviour I cannot account for, the check is written as a
    // value that can be printed, and it is verified BOTH ways — it passes on clean source and
    // fails when `getUTCHours` is replaced with `getHours`.
    const localGetter = /\.get(Date|Hours|Minutes|Month|FullYear|Day)/.exec(body);
    expect(localGetter && localGetter[0], 'a local-time getter makes the label depend on the host').toBeFalsy();
  });

  it('rolls the date when the offset crosses midnight', () => {
    // 22:10Z on the 30th is 07:10 on the 31st in JST.
    const late = Date.UTC(2026, 6, 30, 22, 10, 0);
    expect(formatEvidenceLabel(late, -540)).toBe('31JUL26@07:10');
  });

  it('treats a missing offset as UTC rather than throwing', () => {
    expect(formatEvidenceLabel(UTC, null)).toBe('30JUL26@05:32');
    expect(formatEvidenceLabel(UTC, undefined)).toBe('30JUL26@05:32');
  });

  it('pads a single-digit day, hour and minute', () => {
    expect(formatEvidenceLabel(Date.UTC(2026, 0, 5, 3, 7, 0), 0)).toBe('05JAN26@03:07');
  });

  it('pads a year below 2010 rather than emitting one digit', () => {
    expect(formatEvidenceLabel(Date.UTC(2009, 0, 1, 0, 0, 0), 0)).toBe('01JAN09@00:00');
  });

  it('places the year where it cannot be misread as a day-of-month', () => {
    // The DTG format spells the year in full because its trailing field is ambiguous. Here the
    // year sits between a named month and an @-prefixed clock, so 2 digits are unambiguous.
    const label = formatEvidenceLabel(UTC, 0);
    expect(label).toMatch(/^\d{2}[A-Z]{3}\d{2}@\d{2}:\d{2}$/);
  });
});
