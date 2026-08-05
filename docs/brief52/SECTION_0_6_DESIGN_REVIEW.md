# BRIEF 52 §0.6 — CLASSIFIER DESIGN REVIEW

**Report only. Nothing built, nothing tuned, no dictionary touched.**

---

## THE SHORT ANSWER: THERE WAS NEVER A DESIGN

The classifier arrived complete in **one commit** — `4b28d86`, 10 June 2026, *"W4 — Local
transcription + descriptive classifier (safety floor)"* — alongside the transcription wrapper and
the tone analyser. `git log --follow` on `keywords/en.ts` returns that commit and nothing else:
**the English dictionary has never been edited since the day it was written.** Same for `ja.ts`.

There is no design document, no corpus, no provenance note, no record of where the ten categories
came from or why those words are in them. The word "safety floor" in the commit message is the
closest thing to a stated intent, and it is doing a lot of work.

That is not a criticism of shipping it. A descriptive classifier that never gates anything is a
reasonable thing to build fast. It is a problem now only because a survivor's evidence page renders
its output as findings, and because Brief 52 §A proposes to *tune* it — and you cannot tune
something whose target was never written down.

---

## 1. WHAT THE TEN CATEGORIES ARE FOR

Reconstructed from the code, because nothing states it.

| Category | W | Words | Phrases | What it is evidently trying to detect |
|---|---:|---:|---:|---|
| `weapon` | 5 | 9 | 4 | A named weapon object |
| `violence` | 4 | 14 | 5 | Assault verbs |
| `medical` | 4 | 8 | 8 | Acute medical emergency |
| `restraint` | 3 | 4 | 12 | Victim protest / refusal |
| `fear` | 3 | 5 | 13 | Explicit fear, calls for help |
| `pain` | 3 | 3 | 7 | Present-tense pain |
| `compliance` | 2 | 0 | 9 | Victim capitulation |
| `disorientation` | 2 | 3 | 7 | Drugging, confusion |
| `bargaining` | 2 | 1 | 10 | Victim pleading |
| `profanity-distress` | 2 | 4 | 4 | Volume-corroborated profanity |

**The organising principle is not stated and is not consistent.** Seven of the ten describe the
VICTIM's speech (fear, pain, compliance, bargaining, restraint, disorientation, profanity). Three
describe the AGGRESSOR's (weapon, violence) or the situation. Nothing in the taxonomy marks which
is which, and nothing in the output tells a coordinator whether the words came from the person in
danger or the person causing it. On an evidence surface that distinction is close to the whole
point.

**What it covers:** a shouting match with recognisable English assault vocabulary, in a quiet
room, with the phone close enough for the Web Speech API to transcribe.

**What it does not cover, as categories rather than missing phrases** (from the Brief 55 audit,
unchanged): sexual violence — **absent entirely, both languages**; threat/future-intent grammar
("I'm gonna…"); body-part targeting (no body-part noun exists anywhere except `my arm`/`my leg`);
bladed and asphyxial instrument use; third-party threats (children, pets); aggressor-side coercion;
negation and quotation handling; and any notion of a stopword.

---

## 2. HOW THE DICTIONARIES WERE BUILT

**No evidence of a method.** The lists read as one sitting of free recall — the shape you get from
asking "what would someone say", not from reading transcripts. Three tells:

- **`compliance` has zero `words` and nine `phrases`.** A category built from remembered sentences,
  never decomposed into terms.
- **The Japanese file is not a translation and not an independent build.** Same ten categories,
  same weights, plausible vocabulary — but there is no sign it was checked against how Japanese
  survivors actually speak, and no annotator is named.
- **`bargaining` contains the single word `please`.** Nothing that had been tested against real
  speech would keep `please` as a scoring term.

---

## 3. DO THE THRESHOLDS MEAN ANYTHING?

```ts
const LEVEL_THRESHOLDS = [[8, 'critical'], [5, 'high'], [2.5, 'medium']];
score = keywordWeight + toneWeight + (repetitionDetected ? 1 : 0);
```

**No. They are unfalsifiable as written, and the arithmetic has properties nobody chose.**

- **8, 5 and 2.5 have no derivation.** No corpus, no ROC curve, no target false-positive rate. 2.5
  is presumably "one weight-3 category, or a weight-2 plus a tone signal", but that is
  reconstruction, not intent.
- **The score is an unweighted SUM across categories**, so breadth beats severity. Three weight-2
  categories (`bargaining` + `compliance` + `profanity`) score 6 → **high**. One `weapon` hit scores
  5 → also **high**. "Please, okay okay, fuck" outranks nothing and ties with "he has a gun".
- **Tone is added on the same axis as language.** `elevated-volume` (1.5) + `multi-speaker` (1) +
  `rapid-speech` (1) = 3.5, which is **medium with no words at all**. An argument in a language the
  lexicon does not carry scores the same as one it does.
- **The repetition bump is a flat +1** regardless of what repeated.

**The measured consequence:** production event `febff13d`, transcript *"People don't shut up I'm
gonna cut your throat"*, scored **medium** — entirely from `restraint` matching the contraction
`don't`. The death threat contributed **zero**. The number looked considered and was not connected
to the transcript at all.

---

## 4. IS A KEYWORD LIST THE RIGHT ARCHITECTURE?

**For the safety floor, yes. For what the product now renders, no.**

The architecture has three real virtues that nothing else on the table matches, and they are worth
stating before criticising it:

1. **It runs on-device with no model and no network.** During an incident, on a phone, with no
   signal. That is not a small thing.
2. **It is deterministic and inspectable.** A survivor can be told exactly why a word was flagged.
   A court can be shown the rule. No model card, no drift, no "the classifier said so".
3. **It gates nothing.** The alert dispatches regardless; a wrong score cannot fail to reach anyone.

The failures are not caused by "keywords are bad". They are caused by **matching mechanics nobody
audited**:

- **Prefix tolerance is dangerous.** `matchesToken` matches when `token.startsWith(entry)`, so
  `gun` matches **`gunna`** — a very common transcription of "gonna". *"I'm gunna be late"* scores
  **weapon, weight 5 → high**. This is a plausible severe false positive that has never been
  measured, and it is one line of code, not a lexicon problem.
- **Reverse prefix too**: `entry.startsWith(token)` for tokens ≥3 chars, so `kil` matches `kill`.
- **Punctuation normalisation is why one word became two findings.** `don't` → `don t` → the token
  `don`… and both `don't` and `dont` in the dictionary normalise to entries that match it. One
  utterance, two matched terms, twelve ticks, twenty-four rendered dangers.
- **No stopword policy**, so `stop`, `don't`, `please`, `help` are scoring terms.

**My assessment:** keep the keyword layer as the floor and fix the mechanics, which is cheap and
does not need a corpus. Do **not** put a model on-device to replace it — you lose determinism,
inspectability and offline operation, and you gain a component nobody can explain in court.

If more capability is genuinely needed later, the shape that preserves the virtues is a **second,
server-side pass over the stored transcript**, clearly labelled as a separate opinion, never
overwriting the deterministic record. That is a Brief of its own and it is not urgent.

---

## 5. WHAT I WOULD DO, IN ORDER, AND WHAT EACH NEEDS

| | Needs a corpus? | Why |
|---|---|---|
| **Remove prefix tolerance, or bound it to suffix-only inflection** | **No** | `gun`/`gunna` is a defect by inspection. Measurable against a handful of hand-written cases. |
| **Remove stopwords** (`stop`, `don't`, `dont`, `please`, `help` as bare words) | **No** | False positives by inspection. This is the one you already ruled separable. |
| **Fix apostrophe normalisation** so one token cannot match two entries | **No** | Mechanical. |
| **Separate the VICTIM/AGGRESSOR axis in the taxonomy** | No, but needs design | Changes what the evidence page can say. Domain decision. |
| **Add the missing categories** (sexual violence first) | **Design first, then corpus** | Six of eight gaps are categories that do not exist and therefore have no score to improve. |
| **Tune thresholds** | **Yes, and last** | Tuning weights against a lexicon with a hole where sexual violence should be optimises the wrong function. |

**The order matters more than any individual item.** Brief 52 §A proposed threshold work first;
this review says that is the last step, and that the first three need nothing but a decision.

---

## 6. THE HONEST SUMMARY

The classifier is a competent afternoon's work that has been carrying an evidentiary role for two
months without anyone checking whether it could. It was built as a "safety floor" — a descriptive
extra that gates nothing — and that is exactly what it still is internally. What changed around it
is that its output is now rendered to a survivor as findings and to a coordinator as a threat
level, and neither surface knows how little is behind the number.

Nothing here is urgent in the safety sense: it gates nothing, and it cannot stop an alert. It is
urgent in the credibility sense, and one measured example makes the case better than this whole
document — **an explicit death threat scored `medium` on the strength of the word "don't".**
