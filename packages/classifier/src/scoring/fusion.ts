import type { MatchedCategory, ThreatCategory, ThreatLevel, ToneIndicator, ToneSnapshot } from '../types';

// Pure fusion + summary. Combines signals into descriptive metadata. This is
// NOT a gate — it only describes. The alert is sent regardless (W5/W6).

const LEVEL_THRESHOLDS: ReadonlyArray<readonly [number, ThreatLevel]> = [
  [8, 'critical'],
  [5, 'high'],
  [2.5, 'medium'],
];

/**
 * Combine keyword + tone weight (plus a repetition bump) into a threat level.
 * `hasInput` ensures benign-but-audible input reads as `low` rather than
 * `unknown`; truly empty input is `unknown`.
 */
export function fuseThreatLevel(
  keywordWeight: number,
  toneWeight: number,
  repetitionDetected: boolean,
  hasInput: boolean,
): ThreatLevel {
  const score = keywordWeight + toneWeight + (repetitionDetected ? 1 : 0);
  // ═══ TONE ALONE IS NOT A JUDGEMENT. IT IS THE ABSENCE OF ONE. ══════════════════════════════
  //
  // Brief 52 §D made a ZERO score render as `unclassified` — "we heard something and could not
  // read it" — instead of the reassuring green `low`. It only ever covered score === 0, and a
  // tone signal is not zero: `whisper` weighs 0.5, so whispering with NO words recognised fell
  // straight through to `low`.
  //
  // Measured on a live incident (93ebe889, +6.9s and +12.7s): threatLevel `low`,
  // matchedCategories `[]`, toneIndicators `["whisper"]`. A coordinator saw a green LOW badge
  // over a capture in which the classifier had understood not one word — beside a panel correctly
  // reporting no audio had arrived yet. The fix did not hold because the hole was never at zero.
  //
  // The rule is about KNOWLEDGE, not loudness: if no keyword matched, we did not read the speech,
  // whatever the microphone heard about its volume or pitch. `low` requires having understood
  // something and judged it mild.
  if (keywordWeight === 0 && hasInput) {
    return 'unclassified';
  }
  for (const [threshold, level] of LEVEL_THRESHOLDS) {
    if (score >= threshold) {
      return level;
    }
  }
  if (score > 0) {
    // Scored above zero but below `medium`: the classifier understood something and judged it
    // low. That is a real finding and stays `low`.
    return 'low';
  }
  // ZERO SCORE ON AUDIBLE INPUT IS NOT LOW THREAT. It is the classifier declining to judge —
  // most often because the speech is in a language whose lexicon it does not carry. Reporting it
  // as `low` told a coordinator "we listened and it is fine" when the truth was "we could not
  // read this at all". No threshold moved to fix this; the mapping was simply wrong.
  return hasInput ? 'unclassified' : 'unknown';
}

export function fuseConfidence(
  matchedCount: number,
  indicatorCount: number,
  repetitionDetected: boolean,
): number {
  const raw = 0.3 + 0.12 * (matchedCount + indicatorCount) + (repetitionDetected ? 0.1 : 0);
  return Math.max(0, Math.min(1, raw));
}

const CATEGORY_LABEL: Record<ThreatCategory, string> = {
  weapon: 'Weapon reference',
  violence: 'Violence language',
  restraint: 'Restraint language',
  compliance: 'Coercion/compliance language',
  fear: 'Fear expressed',
  pain: 'Pain expressed',
  medical: 'Medical distress',
  disorientation: 'Disorientation',
  bargaining: 'Bargaining',
  'profanity-distress': 'Distress profanity',
};

/** Build a short, factual, template-based summary for the contact. */
export function buildSummary(
  matched: MatchedCategory[],
  indicators: ToneIndicator[],
  tone: ToneSnapshot | undefined,
  repetitionDetected: boolean,
  languages: string[],
): string {
  const parts: string[] = [];

  for (const entry of matched) {
    parts.push(`${CATEGORY_LABEL[entry.category]}.`);
  }
  if (tone && tone.speakerCount >= 2) {
    parts.push(`${tone.speakerCount} speakers.`);
  }
  if (indicators.includes('elevated-volume')) {
    parts.push('Elevated stress.');
  }
  if (indicators.includes('whisper')) {
    parts.push('Whispered speech.');
  }
  if (indicators.includes('elevated-pitch')) {
    parts.push('Elevated pitch.');
  }
  if (indicators.includes('rapid-speech')) {
    parts.push('Rapid speech.');
  }
  if (indicators.includes('silence-after-activity')) {
    parts.push('Silence after activity.');
  }
  if (repetitionDetected) {
    parts.push('Repeated words.');
  }
  if (languages.length > 1) {
    parts.push(`Languages: ${languages.join(', ')}.`);
  }

  if (parts.length === 0) {
    return 'Audio captured. No specific indicators.';
  }
  return parts.join(' ');
}
