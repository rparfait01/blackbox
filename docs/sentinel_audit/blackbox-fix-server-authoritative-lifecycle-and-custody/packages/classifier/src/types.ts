/**
 * Classification types for the local safety-floor classifier.
 *
 * The classifier is purely DESCRIPTIVE. It never decides whether an alert is
 * sent — activation is the user's decision, already made. These types describe
 * what was heard so the contact has situational awareness. `threatLevel` is
 * metadata for that human, never a gate.
 */

export type ThreatLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

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
