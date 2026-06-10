import type { Classifier } from './classifier';
import type { Classification, ClassificationContext } from './types';
import type { KeywordLibrary } from './keywords/types';
import { getLibraries } from './keywords';
import { detectLanguages, keywordWeight, matchKeywords } from './scoring/keyword-score';
import { scoreTone } from './scoring/tone-score';
import { buildSummary, fuseConfidence, fuseThreatLevel } from './scoring/fusion';

/**
 * The local safety-floor classifier — the entire intelligence layer of v0.
 *
 * Purely descriptive: it reports what was heard (categories, tone, languages,
 * patterns) so the contact has situational awareness. It never gates alert
 * delivery. The scoring it relies on (keyword/tone/fusion) is side-effect-free;
 * this orchestrator only stamps the result time.
 */
export class LocalClassifier implements Classifier {
  private readonly libraries: KeywordLibrary[];

  constructor(libraries: KeywordLibrary[] = getLibraries()) {
    this.libraries = libraries;
  }

  classify(transcript: string, context: ClassificationContext): Promise<Classification | null> {
    const text = transcript.trim();
    const tone = context.tone;
    const hasInput = text.length > 0 || (tone !== undefined && tone.volumeBand !== 'silent');
    if (!hasInput) {
      return Promise.resolve(null);
    }

    const { matched, repetitionDetected } = matchKeywords(text, this.libraries);
    const toneResult = tone ? scoreTone(tone) : { indicators: [], weight: 0 };
    const languages = detectLanguages(text);

    const threatLevel = fuseThreatLevel(
      keywordWeight(matched),
      toneResult.weight,
      repetitionDetected,
      hasInput,
    );

    return Promise.resolve({
      timestamp: Date.now(),
      source: 'local',
      threatLevel,
      matchedCategories: matched,
      toneIndicators: toneResult.indicators,
      languages,
      repetitionDetected,
      summary: buildSummary(matched, toneResult.indicators, tone, repetitionDetected, languages),
      confidence: fuseConfidence(matched.length, toneResult.indicators.length, repetitionDetected),
    });
  }
}
