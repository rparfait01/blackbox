import type { ThreatCategory } from '../types';

/**
 * Keyword data shape. Libraries are pure data files (one per language) so new
 * languages can be added without touching classifier logic.
 *
 * - `words`: single-token entries; prefix-matched for Latin scripts (so a
 *   truncated fragment like "sto—" still matches "stop"), substring-matched for
 *   scripts without word boundaries (e.g. Japanese).
 * - `phrases`: multi-word chunks, substring-matched as a unit ("let me go").
 * - `weight`: per-category contribution to the descriptive threat metadata.
 */
export interface CategoryKeywords {
  weight: number;
  words: string[];
  phrases: string[];
}

export interface KeywordLibrary {
  language: string;
  categories: Partial<Record<ThreatCategory, CategoryKeywords>>;
}
