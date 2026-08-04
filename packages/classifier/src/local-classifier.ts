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

  /**
   * §C — TOTAL BY CONSTRUCTION, because this runs inside a swallowing boundary.
   *
   * The classify tick in the PWA sits in a try/catch that logs and continues, which is right — a
   * classifier crash must never take down a capture. It also means a throw here does not surface
   * as an error: it silently switches threat classification OFF for the rest of the session.
   * That is exactly how the `normalize()` defect hid, and it is why every path below returns
   * rather than throws.
   */
  classify(transcript: string, context: ClassificationContext): Promise<Classification | null> {
    try {
      return Promise.resolve(this.classifyInner(transcript, context));
    } catch (error) {
      // A crash is REPORTED, never swallowed into absence. The event carries a failed
      // classification rather than looking like an event nobody said anything during.
      return Promise.resolve(this.failed(String(error).slice(0, 200)));
    }
  }

  /** The failure record. Loud about what happened, and never a manufactured threat level. */
  private failed(reason: string): Classification {
    return {
      timestamp: Date.now(),
      source: 'local',
      threatLevel: 'unclassified',
      matchedCategories: [],
      toneIndicators: [],
      languages: [],
      repetitionDetected: false,
      summary: 'Classification could not run for this segment.',
      confidence: 0,
      unclassifiedReason: null,
      state: 'failed',
      failureReason: reason,
    };
  }

  private classifyInner(transcript: string, context: ClassificationContext): Classification | null {
    // `.trim()` threw on every non-string — the same shape as the normalize() defect, one
    // function along. String() is the identity on strings, so no transcript scores differently.
    const text = String(transcript ?? '').trim();
    const tone = context?.tone;
    const hasInput = text.length > 0 || (tone !== undefined && tone.volumeBand !== 'silent');
    if (!hasInput) {
      // Genuinely nothing to judge — silence, not speech we could not read. Null here is the
      // caller skipping a tick, and it stays distinct from both unclassified and failed.
      return null;
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

    return {
      timestamp: Date.now(),
      source: 'local',
      threatLevel,
      matchedCategories: matched,
      toneIndicators: toneResult.indicators,
      languages,
      repetitionDetected,
      summary: buildSummary(matched, toneResult.indicators, tone, repetitionDetected, languages),
      // §D — name the reason, and name the language when we can see one. `detectLanguages`
      // reads SCRIPT, so it recognises Japanese text even when no Japanese keyword matched;
      // that is precisely the case a coordinator must not read as calm. Okinawan is written in
      // the same scripts and is not separately detectable, so it reports as Japanese here — the
      // honest statement is about the lexicon missing, not about which language it was.
      unclassifiedReason:
        threatLevel === 'unclassified'
          ? languages.length > 0
            ? `speech detected (${languages.join(', ')}) but no scored terms matched — this device could not judge it`
            : 'audio was heard but produced no scored terms — this device could not judge it'
          : null,
      confidence: fuseConfidence(matched.length, toneResult.indicators.length, repetitionDetected),
      // §C — which of the three things happened, stated rather than left for a reader to infer
      // from a badge. Derived from the level, so it cannot drift out of step with it.
      state: threatLevel === 'unclassified' ? 'unclassified' : 'classified',
      failureReason: null,
    };
  }
}
