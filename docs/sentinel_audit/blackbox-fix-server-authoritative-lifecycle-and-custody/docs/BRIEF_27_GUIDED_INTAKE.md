# BRIEF 27 — GUIDED INTAKE & REPORTING

**GATE: do not begin until Brief 26 (ZK Custody) is proven in production.**
**Nothing here may be built on operator-readable storage. That is the whole reason this is last.**

A guided intake/interview tool producing a **structured case file**. Distinct from, and larger than, the
anonymized-stats layer.

---

## §1 — TAXONOMY: standardize on what exists. Do not invent one.

- Map fields to **NIBRS/UCR** offense categories (US) and **WHO** violence classification.
- **Why:** grant funders (VAWA / OVW) require standardized reporting, and standard categories make data
  comparable across jurisdictions. An invented taxonomy is unusable to a funder.

**Core schema:**

| Field | Notes |
|---|---|
| Incident type | NIBRS/UCR + WHO mapped |
| Date / time range | Range, not a forced exact timestamp |
| Location | **Only as granular as the survivor consents** |
| Relationship to perpetrator | Standard categories |
| Weapon / coercion flags | Structured flags |
| Injury | Structured |
| Reported to authorities | Y / N |
| Prior incidents | Y / N |

---

## §2 — PROGRESSIVE PROMPTS: a trauma-informed interview, not a form

- **FETI-style principles** (Forensic Experiential Trauma Interview): sensory and experiential prompts — *what did
  you feel, hear, see* — **not** linear chronological interrogation.
- **Why this is a requirement, not a preference:** trauma memory is not stored chronologically. Forcing a
  chronological account reduces accuracy **and can retraumatize.**
- **One question at a time.** No rapid-fire.
- **Never auto-advances on silence.**
- **Pause / stop control always visible**, at every step.
- Free-text or voice response per section.
- **The app never grades, challenges, scores, or disputes an answer.**

---

## §3 — AI GUARDRAILS (the standing rule — same as the live dashboard)

| Rule | Enforcement |
|---|---|
| **Structured fields the survivor selects are the authoritative record** | Full stop. The record of authority is never model output |
| Free-text → summary AI pass | **Labeled draft only.** Never the filed record. Never load-bearing |
| No LLM asserts facts | Classification is deterministic/latching, not model-inferred |
| **Survivor reviews and edits before anything is filed** | **Non-negotiable.** Filing cannot complete without it |

**Why the review gate is absolute:** an unreviewed AI paraphrase of a disclosure is both a liability and an
accuracy risk. A hallucinated detail in a sexual-assault report is a serious harm, not a minor bug.

---

## §4 — DESTINATION

| # | Destination | Status | Consent profile |
|---|---|---|---|
| **2** | **Personal case file** — identified, ZK-encrypted under the survivor's own custody, exportable to legal aid/counsel | **BUILD FIRST.** Reuses Brief 26 custody directly | Survivor's own; no external party |
| 1 | **Anonymized public stats** | Strict **survivor-initiated opt-in, per submission**. Structured fields only. **No free text.** k-anonymized. **No re-identification path** | Explicit, per submission, never blanket |
| 3 | **Org / institutional intake** (filed to a shelter's case management) | **Deferred.** Requires org consent workflow + DPA | Explicit per-instance authorization. **Never auto-submitted** |

- Not mutually exclusive — but each carries a different consent, retention, and legal-exposure profile.
- `[A]` **Each destination requires its own explicit, per-submission survivor authorization. No blanket consent
  anywhere.**

---

## ACCEPTANCE

- `[A]` Fields map to NIBRS/UCR + WHO. No invented taxonomy.
- `[L]` One prompt at a time; pause/stop always reachable; never auto-advances on silence.
- `[A]` Structured fields are the record of authority; AI output is labeled draft and cannot be filed unreviewed.
- `[L]` Filing cannot complete until the survivor has reviewed and edited the summary.
- `[L]` Case file stored under ZK custody (Brief 3) — **prove the operator cannot read it.**
- `[A]` Anonymized export, if enabled: structured fields only, per-submission opt-in, k-anonymity enforced, no
  free text, no re-identification path.
- `[A]` No org auto-submission path exists anywhere in the codebase.
- `[L]` Trigger / capture / closure / custody unregressed. §0a Hidden byte-identical.

## DONE
Guided intake producing a standards-mapped structured case file, trauma-informed prompt flow, AI constrained to
labeled draft with a mandatory survivor review gate, stored under proven ZK custody, destination 2 built with 1
as strict opt-in and 3 deferred. Committed; both deploy halves currency-asserted; phone sign-off.

---

**CHAIN:** accounts → 23 Tenancy → 26 ZK Custody → **27 (this)**.
Nothing built on unfinished infrastructure. Nothing stacked.
