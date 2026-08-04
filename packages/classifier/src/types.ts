/**
 * Classification types for the local safety-floor classifier.
 *
 * The classifier is purely DESCRIPTIVE. It never decides whether an alert is
 * sent — activation is the user's decision, already made. These types describe
 * what was heard so the contact has situational awareness. `threatLevel` is
 * metadata for that human, never a gate.
 */

/**
 * Brief 52 §D — UNCLASSIFIED IS A DISTINCT STATE, AND COLLAPSING IT INTO `low` WAS THE DEFECT.
 *
 *   'low'          — the classifier RAN, understood the input, and found low threat.
 *   'unclassified' — the classifier ran and COULD NOT JUDGE. Audible input, zero score.
 *
 * These are not the same claim and must never render the same. The case that forced the
 * distinction is the pilot's: Japanese, mixed Japanese/English, or Okinawan speech whose lexicon
 * misses scores zero, and the old mapping returned `low` for it. Finding no keywords in a
 * language you do not have keywords for is not evidence of calm — it is the absence of evidence,
 * presented to a coordinator as a green badge.
 *
 * 'unknown' is retained and is a THIRD thing: no audible input at all. Silence is not the same as
 * speech we could not read.
 */
export type ThreatLevel = 'unknown' | 'unclassified' | 'low' | 'medium' | 'high' | 'critical';

/** v0 is local-only; AI/device-LLM sources are v1. */
export type ClassificationSource = 'local';

export type ThreatCategory =
  | 'weapon'
  | 'violence'
  | 'restraint'
  | 'compliance'
  | 'fear'
  | 'pain'
  | 'medical'
  | 'disorientation'
  | 'bargaining'
  | 'profanity-distress';

/** Acoustic signals surfaced from the tone analyzer. */
export type ToneIndicator =
  | 'elevated-volume'
  | 'whisper'
  | 'elevated-pitch'
  | 'multi-speaker'
  | 'rapid-speech'
  | 'silence-after-activity';

export type VolumeBand = 'silent' | 'whisper' | 'conversational' | 'elevated';

/** A category that fired, with the dictionary entries that matched. */
export interface MatchedCategory {
  category: ThreatCategory;
  matches: string[];
  weight: number;
}

/**
 * Acoustic snapshot produced by the browser tone analyzer (lib/tone) and
 * consumed by the pure tone scorer. Plain data — no DOM references — so the
 * classifier package stays portable and testable.
 */
export interface ToneSnapshot {
  timestamp: number;
  rms: number; // 0..1 linear
  volumeBand: VolumeBand;
  pitchHz: number | null;
  speechRate: number; // voiced segments per second
  speakerCount: number; // 0, 1, or 2 (rough)
  silenceAfterActivity: boolean;
}

export interface Classification {
  timestamp: number;
  source: ClassificationSource;
  /** Metadata for the contact's reference — NOT a gate for alert delivery. */
  threatLevel: ThreatLevel;
  matchedCategories: MatchedCategory[];
  toneIndicators: ToneIndicator[];
  /** Language codes detected in the transcript (e.g. ['en', 'ja']). */
  languages: string[];
  repetitionDetected: boolean;
  /** Short factual, template-generated description for the contact. */
  summary: string;
  /**
   * Brief 52 §D — WHY the classifier could not judge, when `threatLevel` is 'unclassified'.
   *
   * Null for every other level. A coordinator seeing UNCLASSIFIED must be told why: "speech was
   * detected in a language this device does not classify" is actionable; an unexplained badge is
   * just a different blank field.
   */
  unclassifiedReason: string | null;
  /**
   * Brief 52 §C — WHICH OF THE THREE THINGS HAPPENED. Never inferred by a reader.
   *
   *   'classified'   — ran, understood the input, produced a threat level.
   *   'unclassified' — ran, could not judge (see `unclassifiedReason`).
   *   'failed'       — the classifier itself broke.
   *
   * `failed` is NOT rendered as a threat level. §C requires failure to degrade to maximum
   * URGENCY OF PRESENTATION, never to silence — but manufacturing a CRITICAL out of a crash
   * would be a false positive by construction, and §0.4 is explicit that false positives are
   * spent trust. So a failure is shown loudly AS a failure. "We could not run" and "we ran and
   * found nothing" are different sentences and a coordinator gets the true one.
   */
  state: 'classified' | 'unclassified' | 'failed';
  /** Why the classifier broke. Null unless `state` is 'failed'. */
  failureReason: string | null;
  confidence: number; // 0..1
}

export interface ClassificationContext {
  locale?: string;
  localTime?: string;
  priorSummary?: string;
  sessionDurationMs?: number;
  /** Latest acoustic snapshot, when available. */
  tone?: ToneSnapshot;
}
