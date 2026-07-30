# BRIEF — SUMMARY FIELD CAPTURE (freeze fired keywords into the event record)

**Populates the evidence-review dashboard's summary panel (Aggressor/Victim/Tone/Weapon/Danger) from keywords
the live classifier ALREADY fired. The AI summarizes/files existing signals — it never analyzes media or
concludes anything new.**

Gate: flag-gated with the evidence review (ENVELOPE_ENCRYPTION_ENABLED). Ships dormant.
Standing constraints apply. §0a byte-identical, safety floor untouched, both halves currency-asserted.

---

## THE PRINCIPLE (the line that must not be crossed)
- The live classifier already detects and tags keywords during an event (existing behavior — do not change it).
- At capture, **freeze which keywords fired and their existing tags** into the event record.
- The AI's ONLY role: sort already-fired, already-tagged keywords into the summary fields. It **summarizes and
  files** — it does not analyze audio/video, does not infer, does not conclude, does not add anything that
  wasn't detected.
- `[A]` The AI can ONLY surface keywords that actually fired. If a signal wasn't detected, its field stays
  EMPTY. No guessing, no "there may have been," no upgrading a weak signal to a strong claim.
- `[A]` Frozen at capture — the field values are fixed to what fired during the event and can never be
  re-interpreted, re-run, or drift later.

## §1 — CAPTURE: freeze the fired keywords
- During/at end of an event, record into the event record: which classifier keywords fired, their existing tags
  (person/weapon/danger/tone reference), and timestamps.
- `[A]` This reads the EXISTING classifier output. Do NOT add new detection, new media analysis, or change the
  trigger/classifier behavior. The classifier already does the work; this freezes its output.
- `[A]` Safety floor untouched: freezing keyword output must not add latency or a failure path to trigger or
  capture. Fire-and-forget / post-hoc, never blocking the alarm.

## §2 — FILE: AI sorts frozen keywords into fields
- A summarization pass maps frozen, tagged keywords → summary fields:
  weapon-tagged → Weapon(s); danger-tagged → Danger(s); person references → Aggressor(s)/Victim(s);
  tone signals → Tone.
- `[A]` Deterministic mapping from tags where possible; the AI only condenses wording, never invents content.
- `[A]` A field with no fired keyword stays empty. Never populated by inference.
- `[A]` Output is labeled as system-derived from detected keywords — not an assertion of fact about people.

## §3 — REVIEW: replay, read-only, survivor adds only a name
- The frozen fields replay in the dashboard summary panel, read-only.
- The survivor's only addable element remains a real NAME on a person (per the evidence-review brief).
- `[A]` No edit to the frozen system fields. Read-only, integrity preserved.

## ACCEPTANCE
- `[L]` An event where "knife" fires → Weapon shows it; an event where no weapon keyword fires → Weapon EMPTY.
- `[L]` The AI surfaces only fired keywords — feed it an event and confirm it adds nothing that wasn't detected.
- `[L]` Fields are frozen at capture — re-opening review later shows identical values; nothing re-runs.
- `[L]` Trigger/capture latency unchanged — freezing is non-blocking, proven.
- `[A]` §0a Hidden byte-identical; flag-off leaves it dormant; classifier behavior unchanged.

## DONE
The live classifier's fired keywords are frozen into the event record at capture; an AI pass files them into the
review dashboard's summary fields — surfacing only what actually fired, never inferring or concluding, empty
where nothing fired, frozen so it can't drift. Read-only in review; the survivor adds only a name. Trigger/
capture untouched. Flag-gated, dormant. Committed, pushed, both halves currency-asserted.
