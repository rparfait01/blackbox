# BRIEF 52 — CATEGORY AUDIT. A FINDING, NOT A FIX.

**Filed from Brief 55 §D3. Report only — no dictionary was touched.**
**Ruling that produced this document:** *"Adding 'cut your throat' because it appeared in one test
is tuning-to-sample — the exact thing the corpus hold exists to prevent. Patch the phrase you saw,
miss the ten you didn't."* Brief 55 acceptance 8 was descoped on that basis.

---

## THE FINDING

> **An explicit death threat scored `medium`, on the strength of the contraction "don't".**

Production event `febff13d`, 04 AUG 26, 20:30 JST. Full transcript, all three fragments:

> *"People don't shut up I'm gonna cut your throat | You asked for this you would make me do this
> too | You're so stupid"*

Twelve stored classification rows. Every one identical:

```json
[{"category":"restraint","matches":["don't","dont"],"weight":3}]   threatLevel: medium
```

**"I'm gonna cut your throat" matched nothing.** Not weapon, not violence, not fear. The only
category that fired in the entire event was `restraint`, triggered by the word `don't` in
"People don't shut up" — where `don't` is not restraint at all, it is a subordinate clause in a
complaint about noise. The classifier reached the right *severity band* by coincidence, from a
token that meant nothing, while the actual threat to life was invisible to it.

Two independent failures produced one plausible-looking answer:

1. **A false positive carried the score.** `don't` fired `restraint` in a context with no
   restraint in it.
2. **A total false negative on the threat.** The one sentence that mattered contributed zero.

If either had happened alone it would have been visible. Together they produced `medium` — a
number that looks considered and is not connected to the transcript at all.

---

## §1 — DOES A "DIRECT VIOLENCE AGAINST A PERSON" CATEGORY EXIST?

**A `violence` category exists. A category covering direct physical violence against a person does
not.** What exists is a small list of ASSAULT VERBS, and its shape is the finding:

```
violence.words:   hit beat kill punch choke strangle slam attack smother kick slap stab shoot strike
violence.phrases: "beat me" "kill you" "kill me" "i'll kill" "hold still"
```

Fourteen verbs. Checked against the six terms named in the ruling:

| Term | In any dictionary? |
|---|---|
| `strangle` | **yes** — `violence` |
| `choke` | **yes** — `violence` (and `choking` in `medical`) |
| `stab` | **yes** — `violence` |
| `cut` | **NO** |
| `throat` | **NO** |
| `slit` | **NO** |

So the gap is narrower than "no violence category" and much more specific than a missing phrase.
**The list covers BLUNT and BALLISTIC force and does not cover BLADED or ASPHYXIAL force by
instrument.** `stab` is present; `cut`, `slice`, `slit`, `slash` are absent. `strangle` and `choke`
are present as verbs; no target noun — `throat`, `neck` — exists anywhere, so no phrase describing
an act against a body part can ever match.

**This is a category-shaped hole, not a phrase-shaped one.** Adding `cut your throat` fills a
sentence. It leaves `slit your throat`, `cut you open`, `slash your face`, `open you up`, and every
other bladed construction exactly as invisible as they are today. That is the tuning-to-sample the
hold exists to prevent, and it is why nothing was added.

---

## §2 — ALL TEN CATEGORIES, AND WHAT EACH ACTUALLY COVERS

Audited against `packages/classifier/src/keywords/en.ts`. Counts are literal entries.

| # | Category | W | Words | Phrases | What it actually covers | Gap, stated as a CATEGORY |
|---|---|---|---|---|---|---|
| 1 | `weapon` | 5 | 9 | 4 | **Named weapon objects only.** gun/knife/blade/pistol/firearm/rifle/machete/taser + 4 possession phrases. | **Weapon USE and weapon THREAT, as distinct from weapon PRESENCE.** Every entry is a noun. "I'll cut you" names no object and cannot fire. Also absent: improvised weapons (bat, hammer, bottle, brick, cord, belt), and any reference to ammunition or a weapon being loaded/drawn. |
| 2 | `violence` | 4 | 14 | 5 | **Blunt and ballistic assault verbs.** | **Bladed force** (cut/slit/slash/slice/carve). **Force against a named body part** — no body-part noun exists in any dictionary, so `throat`, `neck`, `face`, `head`, `ribs` are all unmatched. **Sexual violence — ENTIRELY ABSENT as a category, see §3.** **Threats against third parties** ("I'll hurt the kids"). **Property/pet violence as intimidation.** |
| 3 | `restraint` | 3 | 4 | 12 | **Victim protest language** — "let me go", "get off me", "stay back". | **MISCATEGORISED AT THE ROOT.** The name says restraint; the content is refusal. `stop`, `don't`, `dont`, `release` are ordinary high-frequency English that appear in any argument, any complaint, any sentence with a negation. This category is the single largest false-positive source in the system, and it is the one that fired in the incident above. Actual physical restraint — "tied", "held down", "pinned", "locked in", "won't let me leave" — is absent. |
| 4 | `compliance` | 2 | 0 | 9 | **Victim capitulation** — "I'll do whatever", "I won't tell". | **Coercion by the AGGRESSOR, which is the other half of the same dynamic and is what the category name implies.** Threats-to-enforce ("if you tell anyone", "you know what happens"), isolation, and financial or immigration coercion are all absent. Zero `words` — phrase-only, so it fires on nothing partial. |
| 5 | `fear` | 3 | 5 | 13 | **Explicit fear statements + calls for help.** The best-covered category. | Overlaps `bargaining` and `pain` without a resolution rule. `help` alone is very high-frequency. |
| 6 | `pain` | 3 | 3 | 7 | **Present-tense pain expressions.** | Injury REPORTS as distinct from pain ("my arm is broken", "I'm cut"). `my arm`/`my leg` are the only body parts in the entire system and they live here — where they are least useful. |
| 7 | `medical` | 4 | 8 | 8 | **Acute medical emergency.** Genuinely well-shaped. | Overdose/poisoning by another party reads identically to self-harm; nothing distinguishes them. |
| 8 | `disorientation` | 2 | 3 | 7 | **Drugging and confusion.** Well-shaped for its size. | Strangulation aftermath (dizziness/vision loss) is clinically critical and would land here at weight 2. |
| 9 | `bargaining` | 2 | 1 | 10 | **Victim pleading.** | `please` alone as a `word` is a second high-frequency false-positive source, at low weight. Not mapped to any Evidence Review field, so it renders nowhere. |
| 10 | `profanity-distress` | 2 | 4 | 4 | **Volume-corroborated profanity.** | The comment says tone corroborates; the KEYWORD layer fires regardless of tone. Casual profanity scores the same as screamed profanity at the keyword stage. |

---

## §3 — THE GAPS, AS CATEGORIES

Stated as categories that do not exist, per the ruling. Not as phrases to add.

1. **SEXUAL VIOLENCE — absent entirely.** No category, no word, no phrase, in either language. For
   a domestic-violence product this is the largest single hole in the taxonomy, and it is not a
   gap inside a category — there is nothing to add to.
2. **THREAT / FUTURE INTENT — absent as a dimension.** Every category detects a described or
   present state. Nothing detects the grammar of a threat: *"I'm gonna…"*, *"I will…"*, *"you're
   going to…"*. The incident above is precisely this. A threat dimension crossed with the existing
   object nouns would have caught "I'm gonna cut your throat" **without any new violence verb** —
   which is the argument for fixing the shape rather than the word list.
3. **BODY-PART TARGETING — absent.** Two entries exist (`my arm`, `my leg`, in `pain`). No
   `throat`, `neck`, `face`, `head`, `stomach`. Any construction of the form *verb + body part*
   is unmatchable, which is how most violent threats are actually phrased.
4. **BLADED AND ASPHYXIAL INSTRUMENT USE — absent.** `stab` is the sole bladed verb; `strangle`
   and `choke` have no targets or instruments (cord, belt, hands, pillow).
5. **THIRD-PARTY THREATS — absent.** Children, pets, family. A category with distinct legal and
   escalation meaning, and a very common control tactic.
6. **AGGRESSOR-SIDE COERCION — absent.** `compliance` covers only the victim's side. There is no
   category for what is said TO her.
7. **NEGATION AND QUOTATION HANDLING — absent as a mechanism.** "He said he'd kill me" and "I'll
   kill you" score identically. "Don't shoot" fires `violence` on `shoot`.
8. **STOPWORD DISCIPLINE — absent as a policy.** `don't`, `dont`, `stop`, `please`, `help` are
   dictionary entries. Every one is ordinary English. This is what produced the finding.

---

## §4 — JAPANESE

`ja.ts` mirrors the same ten categories. **It inherits every structural gap above**, and any fix
that is phrase-shaped must be made twice while any fix that is shape-shaped is made once. That is
a further argument for the category work over the phrase work.

---

## §5 — WHAT THIS MEANS FOR BRIEF 52 §A/§B

The corpus hold is correct and this audit strengthens it. But it now has a second requirement:

**A corpus alone cannot close these gaps.** A corpus measures the CURRENT taxonomy's accuracy. Six
of the eight gaps in §3 are categories that do not exist, so no amount of labelled audio will
improve their score — they have no score. The corpus tells us how well we detect what we already
try to detect; it says nothing about the thing we do not attempt.

**Recommended order:**

1. **Taxonomy design first** — decide the categories and dimensions, especially sexual violence
   and threat/future-intent. This is a domain and survivor-safety question, not an engineering one,
   and it should involve someone who does this work.
2. **Corpus second**, built to exercise the taxonomy that results, including negatives for the
   stopword class.
3. **Thresholds last**, tuned against that corpus.

Doing (3) before (1) tunes the weights of a lexicon with a hole where sexual violence should be.

**One item is separable and does not need the corpus:** `restraint` firing on `don't`/`dont`/`stop`
is a false positive by inspection, not by measurement, and it is currently the highest-volume
signal the system produces. It can be removed on its own evidence. It is NOT removed here — no
dictionary was touched in this brief — but it is the one item that does not have to wait.
