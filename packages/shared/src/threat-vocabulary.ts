/**
 * Brief 55 §D — THE ONE VOCABULARY. What a detected category is CALLED, which field it belongs
 * to, and how threat levels rank. One definition, read by every surface that renders a
 * classification.
 *
 * ═══ WHAT THE DEVICE TEST ACTUALLY SHOWED ════════════════════════════════════════════════════
 *
 * The brief that produced this file reported "two summarizers, two answers" — the live
 * coordinator dashboard and Evidence Review disagreeing about one capture. The stored rows
 * refuted that: the two readings were two DIFFERENT events, and both surfaces had rendered their
 * own event faithfully. There was no second classifier to delete, and deleting one would have
 * removed a correct renderer.
 *
 * The real defect was a vocabulary split. Both surfaces read the same table and then said
 * different KINDS of thing about it:
 *
 *   dashboard       → the category, named:  "Restraint language"
 *   Evidence Review → the raw matched terms: "don't ×12 · dont ×12"
 *
 * The transcript behind that second rendering contained the word `don't` exactly ONCE. Apostrophe
 * normalisation matched it against both the `don't` and `dont` dictionary entries, and twelve
 * classification ticks each re-recorded the same latched match. One word, rendered to a survivor
 * as twenty-four dangers, on the same page as an explicit death threat the record was silent
 * about.
 *
 * So the rule is: **a surface renders the CATEGORY, never the matched tokens.** The category is
 * the finding; the token is dictionary trivia that happens to be how the finding was reached.
 * That single rule removes the stopword noise, removes the double-count, removes the ×12
 * inflation, and makes the two surfaces say the same words about the same event — without either
 * of them computing anything.
 *
 * ═══ WHY THE LABELS SAY "REFERENCE" AND "LANGUAGE" ═══════════════════════════════════════════
 *
 * Every label names a property of SPEECH, not a fact about the room. "Weapon reference" is a
 * claim that a weapon was spoken of; it is not a claim that a weapon was present. That
 * distinction is load-bearing on an evidence surface: the survivor corroborates what was actually
 * there, and the system records only what it heard. Never upgrade an implication to a
 * confirmation — the same principle as `unclassified` versus `low`.
 */

/**
 * The published label for each detected category. Mirrors the classifier's rule set so a
 * rendered situation is auditable against the dictionary that produced it.
 */
export const CATEGORY_LABEL: Record<string, string> = {
  weapon: 'Weapon reference',
  violence: 'Violence language',
  restraint: 'Restraint language',
  compliance: 'Coercion / compliance',
  fear: 'Fear expressed',
  pain: 'Pain expressed',
  medical: 'Medical distress',
  disorientation: 'Disorientation',
  bargaining: 'Bargaining',
  'profanity-distress': 'Distress profanity',
};

/**
 * The reader-facing name of a category. An unmapped category falls through to its own key rather
 * than being dropped: a signal we have no label for is still a signal, and silence about it would
 * be the same failure as the blank summary.
 */
export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

/** Categories that belong to the WEAPON REFERENCES field. */
export const WEAPON_CATEGORIES: ReadonlySet<string> = new Set(['weapon']);

/** Categories that belong to the DANGER SIGNALS field. */
export const DANGER_CATEGORIES: ReadonlySet<string> = new Set(['violence', 'restraint', 'pain', 'medical']);

/**
 * The monotonic ranking, with `unclassified` between "no audible input" and "low".
 *
 * The order is a claim about how much we KNOW, not only about severity:
 *   unknown      — no audible input at all
 *   unclassified — audible input we could not read (a missing lexicon, most often)
 *   low…critical — we read it and judged it
 *
 * DEFINED ONCE because it was previously defined twice, and the two copies disagreed: Evidence
 * Review's list omitted `unclassified` entirely, so `indexOf` returned -1 and an event whose every
 * observation was unclassified reported NO threat level at all on the survivor's own review page.
 * A ranking that silently drops a level is worse than no ranking.
 */
export const THREAT_ORDER: readonly string[] = ['unknown', 'unclassified', 'low', 'medium', 'high', 'critical'];

/** Rank of a level within THREAT_ORDER; -1 when the level is not one we publish. */
export function threatRank(level: string | null | undefined): number {
  return level ? THREAT_ORDER.indexOf(level) : -1;
}
