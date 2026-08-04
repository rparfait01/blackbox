# BRIEF 52 — CLASSIFIER: DOES IT ACTUALLY KNOW WHAT IT IS HEARING

**Status:** §0 answered and reported. **STOPPED THERE**, per the brief — no tuning, no threshold
change, no keyword edit. §A is blocked on a corpus that does not exist; a ruling is requested at
the end.

## CORRECTIONS — None.

§0.5 found no divergence between `CLASSIFIER_RULESET.md` and the code. That is worth stating
rather than passing over: thresholds and the category lexicon match exactly, which is the opposite
of the failure this brief anticipated.

---

## §0.1 — WHAT THE OUTPUT CHANGES

Four consumers, traced. Every one is **presentation or record**. None is control.

| Consumer | What it does with a classification |
|---|---|
| `contact-state.ts` | Builds the coordinator SITUATION block — latched, monotonic union of categories and MAX threat level |
| `dashboard/page.ts` | Renders that block: a `th-badge` plus category chips |
| `channels/messages.ts`, `email-messages.ts` | Adds a **HEARD** line to the alert body when a summary exists |
| `report-metadata.ts` | Replays stored classifications into the certified report — explicitly "not a re-analysis; nothing is recomputed at read time" |

The alert-content path deserves a caveat: `threatSummary` is read at notification time via
`latestSummary()`. At T+0 no classification has run, so the HEARD line is normally absent from the
FIRST alert and appears on later escalation messages. It changes what a contact reads, never
whether they are contacted.

## §0.2 — DOES IT GATE ANYTHING? **NO. Proven three ways.**

This is the P0 question and the answer is clean.

1. `threatLevel` does not appear in `notify.ts`, the dispatcher, or `cascade-do.ts` at all.
2. No conditional anywhere in the Worker or the PWA branches on `threatLevel`, except
   `review/summary.ts`, which ranks levels to pick the highest **for display**.
3. `POST /v1/events/:id/classifications` writes to `classifications_index` and nothing else. It
   updates no event state, sets no escalation tier, and calls neither notify nor the cascade.

Cascade timing is fixed at T+0/+10/+20/+30/+40 by the Durable Object alarm and takes no severity
input. **A classifier returning `low` for every event would change no dispatch, no timing, and no
recipient.** An abuser who knew the entire vocabulary and spoke around it perfectly would still be
unable to quiet an alert.

## §0.3 — WHAT THE COORDINATOR ACTUALLY SEES

The exact rendered string, not the internal score:

```
Threat (rule-derived)    [ CRITICAL ]
```

`s.threatLevel.toUpperCase()` inside a `th-badge`, labelled **Threat (rule-derived)** — wording
that already tells a coordinator this is a rule output rather than a judgement. Category chips
render beneath it from the published `CATEGORY_LABEL` map, and inferences are marked as inferred.

## §0.4 — THE COST ASYMMETRY, AND WHICH ERROR THE DESIGN SHOULD PREFER

**A missed threat and a false alarm are not equal, and the design should prefer the false alarm —
but the reason is narrower than it first looks, and it follows entirely from §0.2.**

Because classification gates nothing, a false negative does **not** mean help is not sent. The
cascade fires regardless. What a false negative costs is a coordinator's *prioritisation*: they
see LOW on an event that was severe and may respond less urgently. What a false positive costs is
a coordinator's *trust*: repeated CRITICAL on ordinary arguments trains someone to discount the
badge, and a discounted badge is worse than no badge — it is the blank-summary problem wearing a
colour.

So the asymmetry is about attention, not dispatch:

- **Prefer over-reporting severity.** A coordinator arriving too urgently is recoverable; one
  arriving late because the badge said LOW is not.
- **False positives are not free.** The ceiling is the point at which coordinators stop reading
  the badge — a human threshold this brief cannot measure without the pilot.
- **`unknown` must never render as low.** The most dangerous error is not a wrong level; it is a
  confident level derived from nothing, which the §D Japanese case produces by construction.

## §0.5 — RULESET DOCUMENT VERSUS CODE

**No divergence found.**

| | Document | Code |
|---|---|---|
| critical / high / medium | 8 / 5 / 2.5 | `LEVEL_THRESHOLDS` = 8 / 5 / 2.5 |
| `>0` low, `0` audible low, `0` silent unknown | stated | `fuseThreatLevel` implements exactly this |
| Categories | 10, named | 10, identical names in `keywords/en.ts` |

---

## WHY THE BRIEF STOPS HERE

**§A's corpus does not exist and cannot be manufactured.** The brief forbids synthesising one from
the keyword list — correctly, since that would test the classifier against its own assumptions and
report excellence. The permitted sources are published DV research corpora, public-record court
transcripts, or specifically-consented pilot recordings. **I have none and cannot obtain them.**
Incident data is excluded absolutely and is not a fallback.

Per §A's own instruction — *"If no adequate corpus is obtainable, say so and stop"* — every number
§B would produce is unavailable, and a validation run against invented data would be a false claim
of safety about a survivor-facing judgement.

**Two findings that do not need the corpus:**

1. **§D is answerable now, and the answer is structural.** `keywords/ja.ts` exists (65 lines against
   English's 141), so Japanese is not unhandled — but `fuseThreatLevel` returns `low` for audible
   input scoring zero. Speech in a language whose lexicon misses therefore renders as **LOW, not as
   unclassified**. Finding no keywords in Japanese speech is not evidence of calm, and the code
   cannot currently tell those apart. This is a state distinction, not a tuning question.

2. **§C's degradation contract is not implemented.** A classifier failure resolves to absence
   rather than to maximum urgency, and the coordinator surface has no classification-state field —
   the same shape as the blank summary panel Brief 50 fixed.

**Requested ruling:** proceed with §C and §D, which are honesty-of-state fixes needing no corpus
and independent of any accuracy question, and hold §A/§B until a corpus with real provenance
exists. Or open the pilot's consented-recording route, which is a consent-design decision rather
than an engineering one.
