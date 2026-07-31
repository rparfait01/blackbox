# BLACK BOX — Fix Brief 5: Deterministic Summary, Frozen Origin & Dashboard Hierarchy

Work order for Claude Code. Replaces the live evolving AI summary with a deterministic,
latching situational summary (NO LLM in the live path), anchors an immutable origin snapshot,
and reorders the dashboard so a responder reads a firm summary and sees the camera, with the
transcript treated as secondary.

**Rules:** Deterministic = no LLM / no external AI call in the live path. Local speech-to-text
(whisper.wasm / Web Speech) stays as the transcript source — that is not the AI being removed.
The classification must be fully explainable from detected signals (evidence-grade).

---

## D1 — Frozen ORIGIN snapshot (solves "no record of what started it")

- At activation (t=0), capture an immutable ORIGIN record: trigger type (deadman/tamper/manual),
  DTG start, initial location, a reference to the first 10–15s of audio, and the initial
  deterministic classification (first keyword categories + voice count detected).
- Write-once. It never updates as the event evolves. It is the anchor for "initial contact."

## D2 — Deterministic situational classifier (no LLM)

- Pipeline: audio → local STT → keyword/rule classifier. No LLM call.
- Threat lexicon organized by category (violence, weapon, coercion/compliance, medical/distress,
  etc.), configurable, with a published rule set so the output is auditable.
- Signals: detected keyword categories (with timestamps), distinct-voice count (light
  diarization), trigger type, motion/location dynamics.
- **Latching:** once a signal latches it stays; the summary only adds or escalates, never
  rewrites or downgrades. Threat level is derived by a transparent rule from the latched
  signals and is monotonic (can rise, does not thrash down).
- Render the summary as assembled detected facts, not a generated free-text sentence.

## D3 — Honesty / evidence guardrail

- The summary states DETECTED FACTS (voice count, keyword categories present, trigger, motion)
  plus a rule-derived threat level. Inferences such as "one aggressor" must be marked
  inferred/low-confidence or omitted — never asserted as fact. Keeps it evidence-grade and
  avoids giving a responder false confidence.

## D4 — Optional AI enrichment (post-hoc, BYOK, OFF the live path)

- If an LLM summary is used at all, it runs post-hoc for the record, is clearly labeled
  AI-generated, and is never load-bearing or in the live emergency path.

## D5 — Dashboard information hierarchy

- Order top to bottom: **ORIGIN** (frozen) → **SITUATION** (stable latching summary) →
  **LIVE CAMERA** (prominent — primary aggressor-ID evidence, shown when a feed exists) →
  **LIVE TRANSCRIPT** (de-emphasized, retained for evidence/replay) → location / audio / devices.
- Transcript must read as secondary in the layout; camera prominent when available.

---

## ACCEPTANCE CRITERIA

1. An immutable ORIGIN snapshot is captured at t=0 and never changes during the event. (D1)
2. The live situational summary is produced with no LLM / external AI call in the live path. (D2)
3. The summary latches: flags persist, threat is monotonic, no second-to-second rewriting. (D2)
4. The summary shows detected facts + rule-based threat; inferred labels are marked, not
   asserted as fact. (D3)
5. Any AI summary is post-hoc, labeled, and off the live path. (D4)
6. Dashboard order is origin → situation → camera → transcript (secondary). (D5)
