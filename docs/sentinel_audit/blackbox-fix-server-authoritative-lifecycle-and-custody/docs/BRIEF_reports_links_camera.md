# BRIEF — REPORT DESTINATIONS · SETTINGS LINKS · REAR CAMERA

**Three grouped items. Clarifies where reports go, surfaces the report/review links in Settings with clear names,
and fixes capture to use the rear camera. Root fixes, not patches.**

Standing constraints apply. §0a Hidden byte-identical. Trigger never gated/taxed. Both halves currency-asserted.
Prove [L] on real device.

---

## GROUP 1 — CAMERA: default to REAR-facing (capture the threat, not the survivor)

**In an emergency the survivor will NOT turn the phone around. The front camera captures her own face; the rear
camera faces away from her — toward the aggressor. Rear is the correct default for evidence.**

- `[A]` Video capture defaults to the **rear/back camera**, not the front. The phone is in a pocket, in-hand, or
  on a surface — rear-facing is far more likely to catch the aggressor.
- `[A]` If the rear camera is unavailable, fall back to whatever camera exists rather than failing capture —
  capture availability is paramount (some capture beats none).
- `[A]` No "hold still / turn the phone" UX. Capture is silent and automatic; the survivor does nothing.
- `[A]` §0a: no camera-selection UI or indicator appears in the Hidden facade.

**[L] PROOF:** trigger → video capture uses the rear camera; verify on a real device the rear lens is used.

---

## GROUP 2 — REPORT DESTINATIONS (clarify + confirm, in code and in copy)

**Two different reports, two different destinations. Do not conflate them.**

| Report | Destination | Custody |
|---|---|---|
| **Official / personal report** (certified, her incident) | **HERS.** Generated on her device, sealed to her key, she exports it (police, counsel, claim) or keeps it. **No central repository. BLACK BOX never holds it.** | Zero-knowledge, hers alone |
| **Anonymous report** (the "it happened" tally) | **Public gap-statistics** — the severed store, published as open aggregate data. Closes the unreported-incident gap. | Severed from identity, no re-identification |

- `[A]` Confirm the **official/personal report has NO server-side central store** — it is generated and held
  client-side, exported by the survivor only. There is no BLACK BOX repository of personal reports, by design.
- `[A]` Confirm the **anonymous tally** flows to the severed public-statistics store (Brief 25), aggregate,
  k-anonymized, no identity. This is the ONLY report with a destination BLACK BOX operates — and it operates the
  pipe, never owns identifiable content.
- `[A]` The UI must make this distinction honest: the official report says plainly it is hers and, once
  downloaded, its privacy is hers to manage (existing custody caution). The anonymous report says plainly it
  contributes to public statistics and cannot be withdrawn.

---

## GROUP 3 — SETTINGS LINKS (surface all three, clearly named)

Settings (Visible side only) must present three clearly-named entries:

- `[A]` **Anonymous Report** — the four-tap tally (Brief 25).
- `[A]` **Official Report** — generate her certified/personal report (flag-gated with ZK; when the flag is off,
  the entry either is hidden or shows an honest "available when secure storage is enabled" state — never a broken
  link).
- `[A]` **Evidence Review** — the survivor dashboard to review her own captures (flag-gated with ZK; same honest
  gated state when off).
- `[A]` Each link has a clear label and a one-line description of what it does.
- `[A]` §0a: none of these render in the Hidden facade — Visible/Settings side only, no tell.
- `[A]` No dead links: a flag-gated entry that isn't active yet shows an honest state, never a 404 or a blank.

**[L] PROOF:** in Settings (Visible), all three entries present and correctly labeled; anonymous report works;
flag-gated entries show honest state when the flag is off and open correctly when on; nothing renders in Hidden.

---

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR per group. Confirm: rear camera used (real device); official report has no
central store; anonymous tally reaches the severed public store; three named Settings links present and §0a-clean.
Deployed hash, both halves asserted.
