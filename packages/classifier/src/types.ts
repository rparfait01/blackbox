/**
 * Classification types, mirroring BLACKBOX_SOFTWARE_SPEC §3.
 *
 * v0 is local-only: the keyword + tone classifier (W4) is the sole intelligence
 * layer. AI/device-native LLM sources are v1, so `ClassificationSource` omits
 * `'ai'` for now.
 */

export type ThreatLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

export type ClassificationSource = 'local-keyword' | 'local-tone';

/** Threat categories the local classifier flags (BLACKBOX_SOFTWARE_SPEC §5/W4). */
export type ThreatCategory =
  | 'weapon'
  | 'violence'
  | 'restraint'
  | 'compliance'
  | 'fear'
  | 'medical';

export interface Classification {
  timestamp: number;
  source: ClassificationSource;
  threatLevel: ThreatLevel;
  /** Categories matched in the transcript. */
  categories: ThreatCategory[];
  speakerCount: number;
  aggressorDetected: boolean;
  weaponDetected: boolean;
  /** Plain-language summary for the contact's view. */
  summary: string;
  /** 0–1 confidence in the assessment. */
  confidence: number;
}

export interface ClassificationContext {
  locale?: string;
  localTime?: string;
  priorSummary?: string;
  sessionDurationMs?: number;
}
