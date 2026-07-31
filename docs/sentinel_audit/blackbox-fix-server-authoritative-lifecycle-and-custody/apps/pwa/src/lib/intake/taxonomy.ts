/**
 * Intake taxonomy (Brief 27 §1) — STANDARDIZED, not invented. Survivor-facing incident
 * types map to real NIBRS/UCR offense codes and the WHO violence typology, because grant
 * funders (VAWA / OVW) require standardized reporting and standard categories make the
 * data comparable across jurisdictions. An invented taxonomy is unusable to a funder.
 *
 *   NIBRS = FBI National Incident-Based Reporting System Group A offense codes.
 *   WHO   = World Health Organization typology of violence (nature + relationship).
 *
 * The survivor selects from plain-language labels; each carries its standardized mapping so
 * the filed record is fundable and comparable. This module is pure and descriptive — it
 * classifies nothing about a specific disclosure; it is a lookup table.
 */

export const TAXONOMY_VERSION = 'nibrs-2019+who-2013/v1';

/** WHO typology — nature of the violence, and (separately) the relationship context. */
export type WhoNature = 'physical' | 'sexual' | 'psychological' | 'economic' | 'neglect';
export type WhoRelationship = 'intimate_partner' | 'family_member' | 'acquaintance' | 'stranger' | 'other_known';

export interface IncidentType {
  /** Stable key stored on the record. */
  id: string;
  /** Plain-language label the survivor sees — never a code. */
  label: string;
  /** NIBRS Group A offense code(s) this maps to (the primary is first). */
  nibrs: string[];
  /** The legacy UCR Part I/II bucket, for older reporting pipelines. */
  ucr: string;
  /** WHO nature-of-violence categories. */
  who: WhoNature[];
}

/**
 * The incident-type catalogue. Codes are the real published NIBRS Group A codes:
 *   11A Rape · 11B Sodomy · 11C Sexual Assault With An Object · 11D Fondling ·
 *   36B Statutory Rape · 13A Aggravated Assault · 13B Simple Assault · 13C Intimidation ·
 *   100 Kidnapping/Abduction · 64A Human Trafficking (Commercial Sex Acts) ·
 *   90Z All Other Offenses (used for stalking/coercive control, which NIBRS carries as
 *   circumstances/flags rather than a standalone Group A offense — see flags below).
 */
export const INCIDENT_TYPES: IncidentType[] = [
  { id: 'sexual_assault_penetration', label: 'Sexual assault (penetration)', nibrs: ['11A', '11B', '11C'], ucr: 'Rape', who: ['sexual'] },
  { id: 'sexual_assault_contact', label: 'Unwanted sexual contact', nibrs: ['11D'], ucr: 'Sex Offense', who: ['sexual'] },
  { id: 'sexual_harassment', label: 'Sexual harassment', nibrs: ['90Z'], ucr: 'All Other', who: ['sexual', 'psychological'] },
  { id: 'physical_assault_serious', label: 'Physical assault (serious injury / weapon)', nibrs: ['13A'], ucr: 'Aggravated Assault', who: ['physical'] },
  { id: 'physical_assault', label: 'Physical assault (hit, pushed, restrained)', nibrs: ['13B'], ucr: 'Simple Assault', who: ['physical'] },
  { id: 'threats_intimidation', label: 'Threats or intimidation', nibrs: ['13C'], ucr: 'Intimidation', who: ['psychological'] },
  { id: 'coercive_control', label: 'Coercive or controlling behaviour', nibrs: ['90Z'], ucr: 'All Other', who: ['psychological'] },
  { id: 'economic_abuse', label: 'Financial or economic abuse', nibrs: ['90Z'], ucr: 'All Other', who: ['economic'] },
  { id: 'stalking', label: 'Stalking', nibrs: ['90Z'], ucr: 'All Other', who: ['psychological'] },
  { id: 'kidnapping', label: 'Held or taken against your will', nibrs: ['100'], ucr: 'Kidnapping', who: ['physical', 'psychological'] },
  { id: 'trafficking', label: 'Trafficking / forced acts', nibrs: ['64A'], ucr: 'Human Trafficking', who: ['sexual', 'economic'] },
  { id: 'other', label: 'Something else', nibrs: ['90Z'], ucr: 'All Other', who: [] },
  { id: 'prefer_not_to_say', label: 'Prefer not to say', nibrs: [], ucr: '', who: [] },
];

/** Standard relationship-to-perpetrator categories (WHO relationship dimension). */
export interface RelationshipOption {
  id: string;
  label: string;
  who: WhoRelationship;
}
export const RELATIONSHIPS: RelationshipOption[] = [
  { id: 'current_partner', label: 'Current partner or spouse', who: 'intimate_partner' },
  { id: 'former_partner', label: 'Former partner or spouse', who: 'intimate_partner' },
  { id: 'family_member', label: 'Family member', who: 'family_member' },
  { id: 'acquaintance', label: 'Someone I know', who: 'acquaintance' },
  { id: 'authority_figure', label: 'Someone with authority over me (work, care, etc.)', who: 'other_known' },
  { id: 'stranger', label: 'A stranger', who: 'stranger' },
  { id: 'prefer_not_to_say', label: 'Prefer not to say', who: 'other_known' },
];

/** Structured weapon / coercion flags (not free text). */
export const WEAPON_COERCION_FLAGS: Array<{ id: string; label: string }> = [
  { id: 'weapon_firearm', label: 'A firearm was involved' },
  { id: 'weapon_other', label: 'Another weapon or object was used' },
  { id: 'physical_force', label: 'Physical force was used' },
  { id: 'threats_used', label: 'Threats were used' },
  { id: 'coercion_pressure', label: 'I was pressured or coerced' },
  { id: 'incapacitated', label: 'I was unable to consent (asleep, drugged, drunk)' },
  { id: 'confined', label: 'I was confined or prevented from leaving' },
];

/** Structured injury categories. */
export const INJURY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'none_apparent', label: 'No physical injury' },
  { id: 'minor', label: 'Minor injury (bruising, scratches)' },
  { id: 'serious', label: 'Serious injury (needed or may need medical care)' },
  { id: 'ongoing', label: 'Ongoing or lasting harm' },
  { id: 'prefer_not_to_say', label: 'Prefer not to say' },
];

/** Coarse "roughly when" — a RANGE, never a forced exact timestamp (§1). */
export const WHEN_RANGES: Array<{ id: string; label: string }> = [
  { id: 'past_week', label: 'In the past week' },
  { id: 'past_month', label: 'In the past month' },
  { id: 'past_3_months', label: 'In the past 3 months' },
  { id: 'past_year', label: 'In the past year' },
  { id: 'longer_ago', label: 'Longer ago' },
  { id: 'ongoing', label: 'It is ongoing' },
  { id: 'prefer_not_to_say', label: 'Prefer not to say' },
];

/** The single source of truth for looking up an incident type's standardized mapping. */
export function incidentTypeById(id: string | null): IncidentType | null {
  if (!id) return null;
  return INCIDENT_TYPES.find((t) => t.id === id) ?? null;
}

/** The NIBRS + WHO mapping for a chosen incident type (empty for prefer-not-to-say). */
export function standardizedMapping(id: string | null): { nibrs: string[]; ucr: string; who: WhoNature[] } {
  const t = incidentTypeById(id);
  return { nibrs: t?.nibrs ?? [], ucr: t?.ucr ?? '', who: t?.who ?? [] };
}
