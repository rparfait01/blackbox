/**
 * Canonical-time rendering (Fix Brief 2 #C6). Storage is ALWAYS UTC ms + a tz
 * offset (minutes, in the JS `getTimezoneOffset` convention: minutes to ADD to
 * local to get UTC, e.g. JST = -540). Local time and DTG are render-only — never
 * stored — so ordering and integrity hold across regions.
 *
 * One formatter, two modes:
 *   - DTG (Date-Time Group), e.g. "121830Z JUN 2026" — for the initial event
 *     report header. Always Zulu (UTC). The year is rendered in full (4 digits)
 *     so the trailing field can never be misread as a day-of-month.
 *   - Local, e.g. "2026-06-12 18:30 (UTC+09:00)" — for every subsequent log
 *     entry, in the event's own local time derived from the stored offset.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * DTG: DDHHMM Z MMM YYYY in UTC (Zulu). The literal `Z` is the zone designator.
 * The year is the full 4 digits (not the NATO 2-digit `YY`) because on a
 * civilian alert a trailing "26" reads as June 26th, not 2026 — the year must
 * be unmistakable. Example: 2026-06-12T18:30Z → "121830Z JUN 2026".
 */
export function formatDtg(utcMs: number): string {
  const d = new Date(utcMs);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const mon = MONTHS[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}${hh}${mm}Z ${mon} ${yyyy}`;
}

/** Render the offset label, e.g. -540 → "UTC+09:00", 300 → "UTC-05:00". */
export function formatOffsetLabel(tzOffsetMinutes: number): string {
  // getTimezoneOffset is minutes to add to local to reach UTC; the displayed
  // UTC offset is the negation.
  const utcOffset = -tzOffsetMinutes;
  const sign = utcOffset >= 0 ? '+' : '-';
  const abs = Math.abs(utcOffset);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Local time for a stored UTC instant + offset. Shifts the instant by the offset
 * and reads UTC getters, so the result is independent of the machine doing the
 * rendering. Example: (…18:30Z, -540) → "2026-06-13 03:30 (UTC+09:00)".
 */
export function formatLocal(utcMs: number, tzOffsetMinutes: number | null | undefined): string {
  const offset = tzOffsetMinutes ?? 0;
  const shifted = new Date(utcMs - offset * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
  return `${date} ${time} (${formatOffsetLabel(offset)})`;
}

/**
 * The evidence label for one stored capture, e.g. "30JUL26@14:32".
 *
 * This is the NAME a survivor sees on her own sealed recording, replacing the opaque
 * identifier the blob is stored under. She does not recognise `evt-9f2c…`; she recognises
 * the evening it happened.
 *
 * Rendered in the EVENT'S OWN LOCAL TIME, not Zulu — deliberately unlike formatDtg. A DTG is
 * for the people coordinating a response across zones; this is for the one person who was
 * there, and she remembers the local clock. Like formatLocal, the instant is shifted by the
 * stored offset and read with UTC getters, so the label is identical on every device that
 * renders it rather than drifting with the reader's own zone.
 *
 * The 2-digit year is safe HERE, unlike in a DTG. formatDtg spells the year in full because
 * its trailing field would otherwise read as a day-of-month ("121830Z JUN 26"). In this
 * format the year is not trailing — it sits between a named month and an `@`-prefixed clock
 * time — so "30JUL26" cannot be misread.
 */
export function formatEvidenceLabel(utcMs: number, tzOffsetMinutes: number | null | undefined): string {
  const offset = tzOffsetMinutes ?? 0;
  const shifted = new Date(utcMs - offset * 60_000);
  const dd = pad2(shifted.getUTCDate());
  const mon = MONTHS[shifted.getUTCMonth()];
  const yy = pad2(shifted.getUTCFullYear() % 100);
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  return `${dd}${mon}${yy}@${hh}:${mm}`;
}

/** Just the local clock time, e.g. "18:30" — for compact contact-facing copy. */
export function formatLocalClock(utcMs: number, tzOffsetMinutes: number | null | undefined): string {
  const offset = tzOffsetMinutes ?? 0;
  const shifted = new Date(utcMs - offset * 60_000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}
