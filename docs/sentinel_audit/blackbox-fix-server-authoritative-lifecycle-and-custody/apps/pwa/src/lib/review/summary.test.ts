import { describe, expect, it } from 'vitest';

import { buildSummaryPanel, toneLabel, type RecordedObservation } from './summary';

/**
 * The summary panel's contract: it SORTS what was recorded and adds nothing. These tests are
 * the mechanical form of that promise — most of them assert an ABSENCE, because the failure
 * mode that matters here is the panel saying more than the record said.
 */

function obs(over: Partial<RecordedObservation> = {}): RecordedObservation {
  return {
    timestamp: 1_000,
    threatLevel: null,
    matchedCategories: [],
    toneIndicators: [],
    summaryText: null,
    languages: [],
    ...over,
  };
}

describe('a field shows only what actually fired', () => {
  it('a weapon keyword that fired appears verbatim under Weapon(s)', () => {
    const panel = buildSummaryPanel([
      obs({ matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }] }),
    ]);
    expect(panel.weapons.map((w) => w.label)).toEqual(['knife']);
    expect(panel.empty).toBe(false);
  });

  it('no weapon keyword → Weapon(s) is EMPTY, not "none detected"', () => {
    const panel = buildSummaryPanel([
      obs({ matchedCategories: [{ category: 'violence', matches: ['hit'], weight: 2 }] }),
    ]);
    expect(panel.weapons).toEqual([]);
    // ...and the danger signal that DID fire is still reported.
    expect(panel.dangers.map((d) => d.label)).toEqual(['hit']);
  });

  it('an entirely empty record reports empty rather than inventing a baseline', () => {
    const panel = buildSummaryPanel([obs()]);
    expect(panel.empty).toBe(true);
    expect(panel.weapons).toEqual([]);
    expect(panel.dangers).toEqual([]);
    expect(panel.tone).toEqual([]);
    expect(panel.highestThreatLevel).toBeNull();
  });

  it('no observations at all is empty, and does not throw', () => {
    expect(buildSummaryPanel([]).empty).toBe(true);
  });

  it('a category outside the mapping is DROPPED, never guessed into a bucket', () => {
    // 'bargaining' is a real recorded category with no summary field. Landing it in Dangers
    // would read as a danger finding the record never made.
    const panel = buildSummaryPanel([
      obs({ matchedCategories: [{ category: 'bargaining', matches: ['please stop'], weight: 1 }] }),
    ]);
    expect(panel.dangers).toEqual([]);
    expect(panel.weapons).toEqual([]);
  });

  it('a fired category with no recorded term still reports the category — presence is never dropped', () => {
    const panel = buildSummaryPanel([obs({ matchedCategories: [{ category: 'weapon', matches: [], weight: 3 }] })]);
    expect(panel.weapons.map((w) => w.label)).toEqual(['weapon']);
  });
});

describe('the system never names a person', () => {
  it('Aggressor(s) and Victim(s) are empty even when strong signals fired', () => {
    const panel = buildSummaryPanel([
      obs({
        threatLevel: 'critical',
        matchedCategories: [
          { category: 'weapon', matches: ['knife'], weight: 3 },
          { category: 'violence', matches: ['hit'], weight: 3 },
        ],
        toneIndicators: ['multi-speaker', 'elevated-volume'],
      }),
    ]);
    expect(panel.aggressors).toEqual([]);
    expect(panel.victims).toEqual([]);
  });

  it('a second voice is reported as a COUNT, never as an identity', () => {
    const heard = buildSummaryPanel([obs({ toneIndicators: ['multi-speaker'] })]);
    expect(heard.multipleSpeakersHeard).toBe(true);
    expect(heard.aggressors).toEqual([]);

    const alone = buildSummaryPanel([obs({ toneIndicators: ['whisper'] })]);
    expect(alone.multipleSpeakersHeard).toBe(false);
  });
});

describe('the panel is a frozen replay', () => {
  const record = [
    obs({ timestamp: 1_000, matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }] }),
    obs({ timestamp: 5_000, threatLevel: 'high', toneIndicators: ['whisper'] }),
  ];

  it('the same record always produces the same panel', () => {
    expect(JSON.stringify(buildSummaryPanel(record))).toBe(JSON.stringify(buildSummaryPanel(record)));
  });

  it('repeated sightings are counted, and the earliest is kept', () => {
    const panel = buildSummaryPanel([
      obs({ timestamp: 9_000, matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }] }),
      obs({ timestamp: 2_000, matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }] }),
    ]);
    expect(panel.weapons).toHaveLength(1);
    expect(panel.weapons[0].observations).toBe(2);
    expect(panel.weapons[0].firstAt).toBe(2_000);
  });

  it('the highest recorded threat level wins, regardless of arrival order', () => {
    expect(
      buildSummaryPanel([obs({ threatLevel: 'critical' }), obs({ threatLevel: 'low' })]).highestThreatLevel,
    ).toBe('critical');
    expect(
      buildSummaryPanel([obs({ threatLevel: 'low' }), obs({ threatLevel: 'critical' })]).highestThreatLevel,
    ).toBe('critical');
  });
});

describe('the panel develops with the replay position', () => {
  const record = [
    obs({ timestamp: 1_000, matchedCategories: [{ category: 'weapon', matches: ['knife'], weight: 3 }] }),
    obs({ timestamp: 9_000, matchedCategories: [{ category: 'violence', matches: ['hit'], weight: 3 }] }),
  ];

  it('only what had been observed by the cutoff is shown', () => {
    const early = buildSummaryPanel(record, 5_000);
    expect(early.weapons.map((w) => w.label)).toEqual(['knife']);
    expect(early.dangers).toEqual([]);
  });

  it('the whole event is shown with no cutoff', () => {
    const all = buildSummaryPanel(record);
    expect(all.weapons.map((w) => w.label)).toEqual(['knife']);
    expect(all.dangers.map((d) => d.label)).toEqual(['hit']);
  });
});

describe('malformed rows never deny her the panel', () => {
  it('null/garbage collections degrade to empty instead of throwing', () => {
    const broken = {
      timestamp: 1,
      threatLevel: null,
      matchedCategories: null,
      toneIndicators: null,
      summaryText: null,
      languages: null,
    } as unknown as RecordedObservation;
    expect(() => buildSummaryPanel([broken])).not.toThrow();
    expect(buildSummaryPanel([broken]).empty).toBe(true);
  });

  it('blank terms and blank tone signals are ignored rather than rendered as empty chips', () => {
    const panel = buildSummaryPanel([
      obs({ matchedCategories: [{ category: 'weapon', matches: ['  ', 'bat'], weight: 1 }], toneIndicators: ['', 'whisper'] }),
    ]);
    expect(panel.weapons.map((w) => w.label)).toEqual(['bat']);
    expect(panel.tone.map((t) => t.label)).toEqual(['whisper']);
  });
});

describe('recorded notes and languages are carried, not composed', () => {
  it('capture-time lines are kept verbatim and in order', () => {
    const panel = buildSummaryPanel([
      obs({ timestamp: 9_000, summaryText: 'Second line.' }),
      obs({ timestamp: 1_000, summaryText: 'First line.' }),
    ]);
    expect(panel.recordedNotes.map((n) => n.text)).toEqual(['First line.', 'Second line.']);
  });

  it('languages are deduplicated', () => {
    const panel = buildSummaryPanel([obs({ languages: ['en', 'ja'] }), obs({ languages: ['en'] })]);
    expect(panel.languages).toEqual(['en', 'ja']);
  });
});

describe('tone wording is a rename, never a reinterpretation', () => {
  it('known signals get plain-language labels and unknown ones pass through untouched', () => {
    expect(toneLabel('multi-speaker')).toBe('More than one voice');
    expect(toneLabel('some-future-signal')).toBe('some-future-signal');
  });
});
