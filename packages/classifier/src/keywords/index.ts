import type { KeywordLibrary } from './types';
import { en } from './en';
import { ja } from './ja';

export type { CategoryKeywords, KeywordLibrary } from './types';
export { en } from './en';
export { ja } from './ja';

/** All shipped keyword libraries. v0 ships English + Japanese. */
export function getLibraries(): KeywordLibrary[] {
  return [en, ja];
}
