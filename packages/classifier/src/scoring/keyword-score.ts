import type { MatchedCategory, ThreatCategory } from '../types';
import type { KeywordLibrary } from '../keywords/types';

// Pure keyword scoring. No side effects.

const PUNCTUATION = /[.,!?;:"'`~()[\]{}<>/\\|@#$%^&*_+=…。、！？「」『』（）-]/g;
const CJK = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** Latin word match with prefix tolerance (handles truncated fragments). */
function matchesToken(tokens: string[], entry: string): boolean {
  for (const token of tokens) {
    if (token === entry) {
      return true;
    }
    if (entry.length <= 2) {
      continue; // short entries (e.g. "no", "ow") require an exact token
    }
    if (token.startsWith(entry)) {
      return true; // "stopped" contains "stop"
    }
    if (token.length >= 3 && entry.startsWith(token)) {
      return true; // truncated fragment: "sto" -> "stop"
    }
  }
  return false;
}

export interface KeywordMatchResult {
  matched: MatchedCategory[];
  repetitionDetected: boolean;
}

export function matchKeywords(
  transcript: string,
  libraries: KeywordLibrary[],
): KeywordMatchResult {
  const normalized = normalize(transcript);
  const tokens = normalized.length > 0 ? normalized.split(' ') : [];

  const byCategory = new Map<ThreatCategory, { matches: Set<string>; weight: number }>();
  const record = (category: ThreatCategory, entry: string, weight: number): void => {
    const existing = byCategory.get(category);
    if (existing) {
      existing.matches.add(entry);
      existing.weight = Math.max(existing.weight, weight);
    } else {
      byCategory.set(category, { matches: new Set([entry]), weight });
    }
  };

  for (const library of libraries) {
    for (const category of Object.keys(library.categories) as ThreatCategory[]) {
      const def = library.categories[category];
      if (!def) {
        continue;
      }
      for (const word of def.words) {
        const entry = normalize(word);
        if (!entry) {
          continue;
        }
        const hit = hasCjk(entry) ? normalized.includes(entry) : matchesToken(tokens, entry);
        if (hit) {
          record(category, word, def.weight);
        }
      }
      for (const phrase of def.phrases) {
        const entry = normalize(phrase);
        if (entry && normalized.includes(entry)) {
          record(category, phrase, def.weight);
        }
      }
    }
  }

  const matched: MatchedCategory[] = [...byCategory.entries()].map(([category, value]) => ({
    category,
    matches: [...value.matches],
    weight: value.weight,
  }));

  return { matched, repetitionDetected: detectRepetition(tokens) };
}

/** 3+ rapid repeats of any short word flags a repetition signal. */
export function detectRepetition(tokens: string[]): boolean {
  let run = 1;
  for (let i = 1; i < tokens.length; i += 1) {
    const current = tokens[i];
    if (current && current === tokens[i - 1] && current.length >= 2) {
      run += 1;
      if (run >= 3) {
        return true;
      }
    } else {
      run = 1;
    }
  }
  return false;
}

/** Detect languages present by script (rough but dependency-free). */
export function detectLanguages(transcript: string): string[] {
  const languages: string[] = [];
  if (CJK.test(transcript)) {
    languages.push('ja');
  }
  if (/[a-z]/i.test(transcript)) {
    languages.push('en');
  }
  return languages;
}

export function keywordWeight(matched: MatchedCategory[]): number {
  return matched.reduce((sum, entry) => sum + entry.weight, 0);
}
