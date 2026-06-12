/**
 * Static region + country-code options for the sign-up form (W8A). Mirrors the
 * regions seeded in migration 0005. The region is auto-populated from the chosen
 * country code but stays user-editable.
 */

export interface RegionOption {
  id: string;
  label: string;
}

export const REGIONS: RegionOption[] = [
  { id: 'jp', label: 'Japan' },
  { id: 'jp-47', label: 'Okinawa Prefecture' },
  { id: 'us', label: 'United States' },
  { id: 'gb', label: 'United Kingdom' },
];

export interface CountryOption {
  code: string;
  label: string;
  regionId: string;
}

export const COUNTRY_CODES: CountryOption[] = [
  { code: '+81', label: 'Japan (+81)', regionId: 'jp' },
  { code: '+1', label: 'United States (+1)', regionId: 'us' },
  { code: '+44', label: 'United Kingdom (+44)', regionId: 'gb' },
];

/**
 * Optional nationality (citizenship) options for sign-up — distinct from the
 * operating Region (which drives emergency numbers). Brief 13 A2/B2. Stored as a
 * plain string; an empty value means the user chose not to say.
 */
export const NATIONALITIES: string[] = [
  'Japanese',
  'American',
  'British',
  'Australian',
  'Canadian',
  'Chinese',
  'Filipino',
  'French',
  'German',
  'Indian',
  'Korean',
  'Other',
];

/** Best-effort default country from the browser locale (pilot defaults to Japan). */
export function defaultCountry(): CountryOption {
  const tag = (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase();
  if (tag.includes('-us') || tag === 'en') {
    return COUNTRY_CODES[1]!;
  }
  if (tag.includes('-gb')) {
    return COUNTRY_CODES[2]!;
  }
  return COUNTRY_CODES[0]!;
}
