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
  for (const [threshold, level] of LEVEL_THRESHOLDS) {
    if (score >= threshold) {
      return level;
    }
  }
  if (score > 0) {
    return 'low';
  }
  return hasInput ? 'low' : 'unknown';
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
