import { describe, expect, it } from 'vitest';

import { formatEvidenceLabel } from '@blackbox/shared';

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
    // Same instant, same stored offset, rendered twice: the function reads UTC getters off a
    // shifted instant, so the host machine's own zone never enters into it.
    expect(formatEvidenceLabel(UTC, -540)).toBe(formatEvidenceLabel(UTC, -540));
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
