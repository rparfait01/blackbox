# BLACK BOX — Deterministic Classifier Rule Set (Fix Brief 5)

The live situational classifier is **fully deterministic — no LLM, no external AI
call in the live path.** Audio → local speech-to-text (Web Speech / whisper.wasm)
→ keyword + tone rule classifier. Every output is explainable from detected
signals; this document is the published, auditable rule set.

## Inputs (signals)
- **Detected keyword categories** (with timestamps), matched from a configurable
  threat lexicon by category.
- **Tone indicators** from the local tone analyzer: elevated-volume, whisper,
  elevated-pitch, multi-speaker, rapid-speech, silence-after-activity.
- **Distinct-voice count** (light diarization, `ToneSnapshot.speakerCount`).
- **Trigger type** (manual / deadman / tamper) and motion/location dynamics.

## Categories (threat lexicon)
`weapon`, `violence`, `restraint`, `compliance` (coercion), `fear`, `pain`,
`medical`, `disorientation`, `bargaining`, `profanity-distress`. Each entry is a
weighted keyword set; the lexicon is in `packages/classifier/src/keywords/`.

## Threat derivation (per classification tick)
`score = keywordWeight + toneWeight + (repetition ? 1 : 0)`, mapped by fixed
thresholds (`packages/classifier/src/scoring/fusion.ts`):

| score ≥ | level |
|---|---|
| 8 | critical |
| 5 | high |
| 2.5 | medium |
| >0 | low |
| 0 (audible) | **unclassified** |
| 0 (silent) | unknown |

**`unclassified` is not a severity (Brief 52 §D).** It means the classifier ran and could not
judge — audible input that produced no scored terms, most often speech in a language whose lexicon
this device does not carry. It previously mapped to `low`, which told a coordinator "we listened
and it is fine" when the truth was "we could not read this at all". Finding no keywords in
Japanese speech is not evidence of calm.

Ranking, which is a claim about how much is KNOWN and not only about severity:
`unknown` < `unclassified` < `low` < `medium` < `high` < `critical`.

## Classification state (Brief 52 §C)

Every classification carries `state`, so a reader never infers it from a badge:

| state | meaning |
|---|---|
| `classified` | ran, understood the input, produced a level |
| `unclassified` | ran, could not judge — see `unclassifiedReason` |
| `failed` | the classifier itself broke — see `failureReason` |

A failure is shown loudly AS a failure and never as a manufactured `critical`: inventing a threat
level out of a crash is a false positive by construction, and false positives are spent
coordinator trust. "We could not run" and "we ran and found nothing" are different sentences.

## Latching + monotonicity (the SITUATION summary)
The contact dashboard's SITUATION is **assembled from detected facts**, not
generated free text, and is **latched** server-side (`getContactState` →
`buildSituation`):
- **Categories**: union across all ticks, keyed by **first-seen** timestamp.
- **Threat level**: the **maximum** ever observed — monotonic, it can rise but
  never thrashes down second-to-second.
- **Tone indicators**: union across all ticks.

## Honesty / evidence guardrail (D3)
The summary states **detected facts** + a **rule-derived threat level**.
Inferences are marked, never asserted: e.g. multiple voices renders as
"Multiple voices detected — inferred, low confidence". The system never asserts
"one aggressor".

## ORIGIN snapshot (D1)
At ~t=0 an immutable ORIGIN record is frozen (write-once): trigger type, DTG
start, initial location, a reference to the first 10–15s of audio, and the first
deterministic classification (initial categories + voice count). It never updates.

## AI enrichment (D4)
Any LLM summary is **post-hoc, BYOK, clearly labeled AI-generated, and never on
the live emergency path**. None is wired in v0; the live path is the rule
classifier above.
