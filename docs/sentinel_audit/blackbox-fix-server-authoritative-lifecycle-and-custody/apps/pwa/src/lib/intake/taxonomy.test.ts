import { describe, expect, it } from 'vitest';

import {
  INCIDENT_TYPES,
  INJURY_OPTIONS,
  RELATIONSHIPS,
  TAXONOMY_VERSION,
  WEAPON_COERCION_FLAGS,
  incidentTypeById,
  standardizedMapping,
} from './taxonomy';

/**
 * Brief 27 §1 — the taxonomy is STANDARDIZED, not invented. These pin that every incident
 * type carries real NIBRS Group A codes + a WHO category, so a filed record is fundable
 * (VAWA/OVW) and comparable across jurisdictions.
 */

// Real published NIBRS Group A offense codes this catalogue is allowed to use.
const KNOWN_NIBRS = new Set(['11A', '11B', '11C', '11D', '36B', '13A', '13B', '13C', '100', '64A', '90Z']);
const KNOWN_WHO = new Set(['physical', 'sexual', 'psychological', 'economic', 'neglect']);

describe('incident types map to REAL NIBRS + WHO codes (no invented taxonomy)', () => {
  it('every NIBRS code used is a known Group A code', () => {
    for (const t of INCIDENT_TYPES) {
      for (const code of t.nibrs) {
        expect(KNOWN_NIBRS.has(code), `${t.id} uses unknown NIBRS code ${code}`).toBe(true);
      }
    }
  });

  it('every WHO category used is a real WHO typology value', () => {
    for (const t of INCIDENT_TYPES) {
      for (const w of t.who) {
        expect(KNOWN_WHO.has(w), `${t.id} uses unknown WHO category ${w}`).toBe(true);
      }
    }
  });

  it('the canonical mappings are correct', () => {
    // Sexual assault (penetration) → NIBRS Rape/Sodomy/SA-with-object + WHO sexual.
    expect(standardizedMapping('sexual_assault_penetration')).toEqual({ nibrs: ['11A', '11B', '11C'], ucr: 'Rape', who: ['sexual'] });
    // Serious physical assault → 13A Aggravated Assault + WHO physical.
    expect(standardizedMapping('physical_assault_serious').nibrs).toContain('13A');
    // Threats → 13C Intimidation + WHO psychological.
    expect(standardizedMapping('threats_intimidation')).toEqual({ nibrs: ['13C'], ucr: 'Intimidation', who: ['psychological'] });
    // Economic abuse → WHO economic.
    expect(standardizedMapping('economic_abuse').who).toContain('economic');
  });

  it('prefer-not-to-say maps to nothing (a real answer, not a forced code)', () => {
    expect(standardizedMapping('prefer_not_to_say')).toEqual({ nibrs: [], ucr: '', who: [] });
    expect(standardizedMapping(null)).toEqual({ nibrs: [], ucr: '', who: [] });
  });
});

describe('the catalogue is well-formed', () => {
  it('ids are unique and labels are plain-language (never a code)', () => {
    const ids = INCIDENT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of INCIDENT_TYPES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.label).not.toMatch(/^\d\d[A-Z]$/); // the label is never a raw NIBRS code
    }
  });

  it('relationship, weapon/coercion, and injury options are structured (not free text)', () => {
    expect(RELATIONSHIPS.length).toBeGreaterThan(3);
    expect(WEAPON_COERCION_FLAGS.every((f) => f.id && f.label)).toBe(true);
    expect(INJURY_OPTIONS.every((o) => o.id && o.label)).toBe(true);
  });

  it('exposes a stable taxonomy version to stamp on a filed record', () => {
    expect(TAXONOMY_VERSION).toMatch(/nibrs/);
    expect(incidentTypeById('stalking')?.nibrs).toEqual(['90Z']);
  });
});
