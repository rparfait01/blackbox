/**
 * The review dashboard's SUMMARY PANEL, derived from the event record.
 *
 * ─── THE LOCKED RULE ────────────────────────────────────────────────────────────────────
 * This module SORTS what was already recorded. It does not analyse media, does not infer,
 * does not conclude, and does not upgrade a weak signal into a strong claim. Every value it
 * returns is traceable to a row that was written during the incident. A field with no
 * recorded signal stays EMPTY — never "possibly", never "none detected" dressed up as a
 * finding, never a model's opinion.
 *
 * That is why this is a pure function over rows the server already holds, with no network
 * call and no model anywhere in it: the panel cannot say more than the record says, because
 * it has nothing else to read.
 *
 * ─── WHY PEOPLE ARE ALWAYS EMPTY ────────────────────────────────────────────────────────
 * Aggressor(s) and Victim(s) are structurally unpopulated, and that is correct rather than
 * unfinished. The detection that ran during the incident matches keywords and acoustic
 * signals; it has no notion of WHO anyone is. Naming a person from a keyword would be the
 * single most damaging inference this screen could make — an evidence surface that guesses
 * at an aggressor's identity is worse than one that stays silent.
 *
 * So the people rows report only what the record genuinely establishes: that more than one
 * speaker was heard, when the tone analysis heard one. Attaching a real NAME is reserved to
 * the survivor and is not part of this read-only replay (see the session report — it is a
 * separate, sealed-to-her-key write, deliberately not built here).
 *
 * ─── WHY IT IS FROZEN ───────────────────────────────────────────────────────────────────
 * Nothing here is recomputed from media at read time, so re-opening a review a year later
 * renders identical values. Evidence that drifts between viewings is not evidence.
 */

import {
  categoryLabel,
  DANGER_CATEGORIES,
  THREAT_ORDER,
  WEAPON_CATEGORIES,
} from '@blackbox/shared';

/** One observation as it was recorded, mirroring the server's ReportClassification. */
export interface RecordedObservation {
  timestamp: number;
  threatLevel: string | null;
  matchedCategories: Array<{ category: string; matches: string[]; weight: number }>;
  toneIndicators: string[];
  summaryText: string | null;
  languages: string[];
}

/** One line in a summary field, with the evidence that put it there. */
export interface SummaryItem {
  /** The published category name — the same words the coordinator surface uses (§D). */
  label: string;
  /** When it was first observed (UTC ms), so she can see where in the recording it came from. */
  firstAt: number;
  /** How many separate observations carried it. Presence, not severity. */
  observations: number;
}

export interface SummaryPanel {
  /** Always empty from the record: the system never names or counts an aggressor. */
  aggressors: SummaryItem[];
  /** Always empty from the record, for the same reason. */
  victims: SummaryItem[];
  /** Acoustic signals the tone analysis surfaced (e.g. whisper, elevated volume). */
  tone: SummaryItem[];
  /** Weapon references that actually fired. */
  weapons: SummaryItem[];
  /** Danger signals that actually fired — violence, restraint, pain, medical. */
  dangers: SummaryItem[];
  /**
   * True only when a second speaker was actually heard. The ONE thing the record can say
   * about people, and it says it as a count, never as an identity.
   */
  multipleSpeakersHeard: boolean;
  /** Highest threat level recorded during the event, or null if none was. Reference only. */
  highestThreatLevel: string | null;
  /** Languages detected in the transcript, deduplicated. */
  languages: string[];
  /**
   * The factual lines written at capture time, in order. These are template-generated
   * sentences from the incident, not a summary composed now.
   */
  recordedNotes: Array<{ at: number; text: string }>;
  /** True when the record carried nothing at all — the panel says so plainly. */
  empty: boolean;
}

/**
 * Brief 55 §D — the bucket tables and the threat ranking are IMPORTED, not declared.
 *
 * They used to be declared here, and the local `THREAT_ORDER` omitted `unclassified` entirely.
 * `indexOf` returned -1 for it, so an event whose every observation was unclassified reported NO
 * threat level at all on the survivor's own review page — while the coordinator dashboard, using
 * its own complete copy, showed NOT CLASSIFIED. A ranking that silently drops a level is worse
 * than no ranking.
 */

/** Collect one term per distinct label, keeping the earliest sighting and a count. */
function collect(entries: Array<{ label: string; at: number }>): SummaryItem[] {
  const byLabel = new Map<string, SummaryItem>();
  for (const e of entries) {
    const existing = byLabel.get(e.label);
    if (existing) {
      existing.observations += 1;
      existing.firstAt = Math.min(existing.firstAt, e.at);
    } else {
      byLabel.set(e.label, { label: e.label, firstAt: e.at, observations: 1 });
    }
  }
  // Chronological: the panel develops in the order the incident did.
  return [...byLabel.values()].sort((a, b) => a.firstAt - b.firstAt || a.label.localeCompare(b.label));
}

/**
 * Build the panel from every observation recorded up to `throughMs`.
 *
 * The cutoff is what makes the panel "develop as she replays": passing the playback position
 * shows only what had been observed by that point in the recording, so the record unfolds at
 * the pace the incident did. Passing Infinity shows the whole event.
 */
export function buildSummaryPanel(observations: RecordedObservation[], throughMs = Infinity): SummaryPanel {
  const inWindow = observations.filter((o) => o.timestamp <= throughMs);

  const weaponTerms: Array<{ label: string; at: number }> = [];
  const dangerTerms: Array<{ label: string; at: number }> = [];
  const toneTerms: Array<{ label: string; at: number }> = [];
  const languages = new Set<string>();
  const notes: Array<{ at: number; text: string }> = [];
  let highest: string | null = null;
  let multiSpeaker = false;

  for (const o of inWindow) {
    for (const cat of o.matchedCategories ?? []) {
      const bucket = WEAPON_CATEGORIES.has(cat.category)
        ? weaponTerms
        : DANGER_CATEGORIES.has(cat.category)
          ? dangerTerms
          : null;
      if (!bucket) continue;
      // ═══ BRIEF 55 §D2 — THE CATEGORY IS THE FINDING. THE TOKEN IS NOT. ═══════════════════
      //
      // This used to push every matched dictionary entry as its own line, on the reasoning that
      // the terms are the evidence and a category name would be "a classification of her
      // situation rather than a record of what was heard." A real capture showed what that
      // produces on a survivor's evidence page:
      //
      //     DANGER(S):  don't ×12  ·  dont ×12
      //
      // The transcript behind it contained the word `don't` exactly ONCE — in "People don't shut
      // up I'm gonna cut your throat." Apostrophe normalisation matched that single token against
      // both the `don't` and `dont` dictionary entries, and twelve classification ticks each
      // re-recorded the same latched match. One word became twenty-four dangers, and it sat
      // directly above a WEAPON(S) field reading "Not recorded."
      //
      // A stopword rendered as a danger does not merely add noise. It spends the credibility of
      // every other field on the page, and the fields it discredits are the ones she would take
      // to a court or a police station.
      //
      // So: one line per CATEGORY per observation, labelled with the published category name —
      // the same words the coordinator dashboard has always used. That is what makes the two
      // surfaces agree without either of them computing anything, and it removes the stopwords,
      // the apostrophe double-count and the tick inflation in a single move, because none of
      // them were ever findings. They were how a finding got made.
      bucket.push({ label: categoryLabel(cat.category), at: o.timestamp });
    }

    for (const tone of o.toneIndicators ?? []) {
      if (typeof tone !== 'string' || !tone.trim()) continue;
      toneTerms.push({ label: tone, at: o.timestamp });
      if (tone === 'multi-speaker') multiSpeaker = true;
    }

    for (const lang of o.languages ?? []) {
      if (typeof lang === 'string' && lang.trim()) languages.add(lang.trim());
    }

    if (o.summaryText?.trim()) {
      notes.push({ at: o.timestamp, text: o.summaryText.trim() });
    }

    if (o.threatLevel) {
      const rank = THREAT_ORDER.indexOf(o.threatLevel);
      const bestRank = highest ? THREAT_ORDER.indexOf(highest) : -1;
      if (rank > bestRank) highest = o.threatLevel;
    }
  }

  const tone = collect(toneTerms);
  const weapons = collect(weaponTerms);
  const dangers = collect(dangerTerms);

  return {
    // Structurally empty — see the header. Not a gap to fill later.
    aggressors: [],
    victims: [],
    tone,
    weapons,
    dangers,
    multipleSpeakersHeard: multiSpeaker,
    highestThreatLevel: highest,
    languages: [...languages].sort(),
    recordedNotes: notes.sort((a, b) => a.at - b.at),
    empty:
      tone.length === 0 &&
      weapons.length === 0 &&
      dangers.length === 0 &&
      notes.length === 0 &&
      highest === null &&
      languages.size === 0,
  };
}

/** Human wording for a recorded tone signal. A rename for legibility only — the underlying
 *  recorded value is unchanged, and no signal is added or reinterpreted. */
const TONE_LABEL: Record<string, string> = {
  'elevated-volume': 'Raised voice',
  whisper: 'Whispering',
  'elevated-pitch': 'Raised pitch',
  'multi-speaker': 'More than one voice',
  'rapid-speech': 'Rapid speech',
  'silence-after-activity': 'Silence after activity',
};

export function toneLabel(indicator: string): string {
  return TONE_LABEL[indicator] ?? indicator;
}
