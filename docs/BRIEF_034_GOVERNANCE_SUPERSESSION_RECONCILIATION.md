# BRIEF 34 — SUPERSESSION CONVENTION + PRE-34 RECONCILIATION

**Type:** GOVERNANCE
**Status:** AUTHORITATIVE. Supersedes no prior brief. Governs every brief from 35 forward.
**Purpose:** Close the gap. Everything before this brief was written without a supersession
convention. This document is the bridge: it establishes the convention, applies a
reconciliation ledger retroactively across Briefs 0B–33, and names every unresolved
numbering collision so no future reader has to guess.

## CORRECTIONS

None. This brief is the origin of the corrections convention.

---

## §1 — THE CONVENTION (mandatory from Brief 35 forward)

Every brief opens with a `## CORRECTIONS` block, before scope, before context, before
anything else.

```
## CORRECTIONS

BRIEF 026 §3 STEP 2 — corrected to read:
"Evidence chunks buffer on-device until encryption state is READY.
No chunk transmits in any other state."
Path: apps/pwa/src/lib/upload/upload-manager.ts

BRIEF 019 §1 — corrected to read:
"..."
```

**Rules:**

| # | Rule |
|---|---|
| 1.1 | **New text only.** Never state what the prior text said. The correction *is* the current reading. |
| 1.2 | **Silence is never implicit.** A brief that supersedes nothing writes `## CORRECTIONS — None.` A missing block is a defect, and the brief is rejected. |
| 1.3 | **Addresses are machine-findable.** Brief number (zero-padded), section, step. Add the file path when the correction lands in code or spec. |
| 1.4 | **One correction per entry.** Never bundle two changes under one address. |
| 1.5 | **Corrections are cumulative-safe.** If Brief 40 corrects text that Brief 37 already corrected, Brief 40 states the current reading in full. A reader arriving at Brief 40 needs nothing earlier. |
| 1.6 | **A correction is not a fix.** The corrections block records what a statement now *says*. The body of the brief records what the code must now *do*. A brief that corrects a claim without fixing the behaviour must say so explicitly in the block. |

**Reading order.** The corpus is read newest to oldest. A reader stops when the picture is
complete. That only works if 1.2 and 1.5 hold without exception — a brief that omits the
block, or writes a delta instead of the full current reading, forces the reader backward
and defeats the convention.

---

## §2 — BRIEF TAXONOMY (mandatory from Brief 35 forward)

| Type | Purpose | Test |
|---|---|---|
| `FIX` | Repairs something that exists and is broken | There is a defect with a reproduction |
| `BUILD` | Adds a capability that does not exist | Nothing is broken; something is missing |
| `REMOVAL` | Deletes a capability, path, or claim | Something must stop existing |
| `VERIFY` | Proves existing behaviour; builds only what it explicitly authorizes | Certifying a floor before stacking on it |
| `GOVERNANCE` | Changes how work is run, numbered, or recorded | Touches no product behaviour |

A brief is exactly one type. A brief that fixes *and* builds is two briefs.

**Filename:** `BRIEF_<NNN>_<TYPE>_<SLUG>.md` — zero-padded to three digits so lexical sort
equals chronological sort.

Example: `BRIEF_035_FIX_DEPLOY_GATE.md`

**Numbering:**

- One number, one brief. Numbers are monotonic and never reused.
- **A brief that fixes something a prior brief shipped carries that brief's number with a
  revision suffix: `BRIEF_033_FIX_A`, `BRIEF_033_FIX_B`.** Only genuinely new capability takes
  a new number. This keeps correlated documents together — a defect and its fix are one
  lineage, not two unrelated files.
- Subdivisions use `§A`, `§B`, `§C` **inside one file**. No more separate `30C` documents.
- Amendments do not get the parent's number. An amendment is a new brief with a corrections
  block pointing at the parent.
- A brief number is allocated when the brief is written, not when it is merged.

**Every brief carries both directions of its dependency links:**

| Section | Purpose |
|---|---|
| `**REQUIRES:**` | What must be green before this brief starts. Named explicitly, with the reason. |
| `## CARRIES FORWARD (open, owned by)` | What this brief deliberately leaves open, and which brief owns it. |

One direction alone is a gap. `CARRIES FORWARD` without `REQUIRES` lets a brief be built out
of order and fail; `REQUIRES` without `CARRIES FORWARD` lets work fall between two briefs that
each assumed the other had it. Both are mandatory. A brief missing either is rejected.

---

## §3 — PRE-34 RECONCILIATION LEDGER

Reconstructed from the brief corpus. Where a brief states its own supersession, that is
recorded as **stated**. Where supersession is deduced from content, it is recorded as
**deduced** and requires Royce's confirmation.

| # | File | Subject | Disposition |
|---|---|---|---|
| 0B | `BRIEF_0B_CLOSURE_SCALES.md` | Closure consent scales to engaged parties | **OPEN — NOT BUILT** as of 2026-07-23. Dual-consent still hardcoded to 2. Carries forward. |
| 1 | `BLACKBOX_FIX_BRIEF.md` | Server-authoritative alert lifecycle (P0–P2) | Superseded in part. The server-authoritative model is the floor and still holds. |
| 1* | `BRIEF_1_ACCOUNTS_VERIFY.md` | "Brief 1 of 4" — accounts verify & certify | **COLLISION.** Separate 4-part series sharing the number 1. See §4. |
| 2 | `BLACKBOX_FIX_BRIEF_2_CUSTODY.md` | Recipient identity, hash chain, sealed vault, trust scoring | Partially live. C3 retention claim **corrected** — see §5. |
| 3, 4 | — | Absent from corpus | Confirm whether allocated. See §4. |
| 5 | `..._5_SUMMARY.md` | Deterministic latching summary, frozen ORIGIN, dashboard order | Live. No known supersession. |
| 6 | `..._6_LIVETEST5.md` | Stand-down has exactly one door; refresh is not a door | Live. Reinforced by 20. |
| 7 | `..._7_COORDINATOR_CLAIM.md` | Coordinator claim on explicit POST only, never passive GET | Live. Locked principle. |
| 8 | `..._8_LIVETEST7.md` | Settings locked during active alert; contact tabs | Live. Extended by 20. |
| 9 | `..._9_V0_CLOSURE_COORDINATOR.md` | v0 roles, contacts, guardian, closure protocol | Superseded in part: pin model by 12; contact ceiling by later decision (§5). |
| 10 | `..._10_DISPATCH_AND_CHECKIN.md` | Fan-out dispatch to all contacts; check-in introduced | **Superseded (stated)** by 11 — fan-out replaced by sequential cascade. |
| 11 | `..._11_CONTACT_CASCADE.md` | Sequential cascade at 15s intervals | Cascade model live. **Timing superseded (deduced)** — see §5. |
| 12 | `..._12_ONE_CLOSURE_PIN.md` | 3-digit on-device closure pin; retire legacy 4-digit | **Absorbed (stated)** into 13. Pin model itself superseded by dual-consent closure. |
| 13 | `..._13_OPERATING_MODEL_AND_FULL_TEST.md` | Authoritative operating model + full function matrix | Superseded as a status snapshot. Its regression discipline carries forward. |
| 14 | `..._14_UNBRICK_FRONT_DOOR.md` | Remove email-verification dependency from auth chain | Superseded by the passwordless rebuild. Its principle holds: signup never depends on outbound email. |
| 15 | 5 files (see §4) | Open modules; single-active session; trigger regression; amendment; hidden-mode trigger | **COLLISION.** Five documents, one number, non-sequential. See §4. |
| 16 | `..._16.md` | Consent, escalation, notifications; removes coordinator-only closure and email-per-event | Live. |
| 17 | `..._17.md` | Check-in regression; location correlation (spec only) | §1 **superseded (stated)** by 19. §2 spec-only, gated on HERE key — confirm status. |
| 18 | 2 files (see §4) | Visible trigger + check-in dead | **COLLISION.** Two documents, one number. Superseded by 22 and the trigger-unify work. |
| 19 | `..._19_CHECKIN_RECIPIENT.md` | Check-in routes to user-designated contact, not guardian | Live. Explicitly supersedes 17 §1. |
| 20 | `..._20_LIVE_ALERT_LOCK.md` | Live-alert state lock; no orphaned events | Live. Load-bearing. |
| 21 | `..._21_CURRENCY.md` | Deploy currency + SW cache staleness guards | Live. **Insufficient** — see §5; extended by Brief 35. |
| 22 | `..._22_VISIBLE_TRIGGER.md` | Visible trigger isolated break | Superseded by trigger-unify (one `triggerAlert()` core). |
| 23 | — | **TENANCY — ABSENT FROM CORPUS.** Gated prerequisite for 24, 26, 28. | **MUST BE LOCATED OR REWRITTEN.** See §4. |
| 24 | `BRIEF_24_ORG_REGISTRATION.md` | Vetted invite-only org registration | Open. Gated on 23. |
| 25 | `BRIEF_25_ANONYMOUS_TALLY.md` | Anonymous incident tally | Open. Gated on 26. |
| 26 | `BRIEF_26_ZK_CUSTODY.md` + `BRIEF_26_REVIEW_ANSWERS.md` | Zero-knowledge custody rebuild + crypto review answers | Open. Gated on 23. **Corrected by Brief 35** — see §5. |
| 27 | `BRIEF_27_GUIDED_INTAKE.md` | Guided intake & reporting | Open. Gated on 26. **COLLISION** — see §4. |
| 28 | `BRIEF_28_ENTITLEMENT_AND_ACTIVATION.md` | Entitlement, web sale, code unlock, IAP | Open. Gated on 23 and Apple account. |
| 29 | 3 files (see §4) | Certified report (2 versions) + closing/arming directions | Built dormant behind `ENVELOPE_ENCRYPTION_ENABLED`. **COLLISION** on version. |
| 30 | `BRIEF_30_SIGNUP_GATE.md` + `BRIEF_30C_SIGNUP_GATE.md` | Signup gate §A/§B/§C | §C split into its own file. **COLLISION** with git-numbered 30 — see §4. |
| 31 | `BRIEF_31_QUOTA_ROOTCAUSE.md` | Decouple test quota from the live alert path | Live. |
| 32 | `BRIEF_32_ACCOUNT_RESET.md` | Prod account reset + operator role | Live. |
| 33 | `BRIEF_33_DASHBOARD.md` | Three-role dashboard + operator panel; server-side boundaries | Live. |
| — | `..._TRIGGER_UNIFY.md` | Unify triggers to one core | **UNNUMBERED IN CORPUS.** Shipped. See §4. |
| — | `..._SAFETY_GAPS.md` | Life-safety gaps fail loud | **UNNUMBERED IN CORPUS.** |
| — | `..._ENCRYPTION.md` | ZK capture encryption + key custody | **UNNUMBERED.** Superseded by 26. |
| — | `..._CLEAN_SLATE_ON_CLOSE.md` | Session state cleared on close | **UNNUMBERED.** Referenced elsewhere as "Brief 27". |
| — | `..._VISIBLE_AFTER_CLOSE.md` | Visible trigger dead after closing Hidden event | **UNNUMBERED.** |
| — | `..._VISIBLE_MODESWITCH_MATRIX.md` | Visible no-op after mode switch | **UNNUMBERED.** Open item per current status. |
| — | `..._cascade_and_line.md` | Cascade timing + LINE delivery | **UNNUMBERED.** Source of corrected cascade timing. |
| — | `BLACKBOX_FIX_TO_GREEN.md` | Zero-regression work orders | Standing header; folded into `STANDING_CONSTRAINTS.md`. |

---

## §4 — UNRESOLVED COLLISIONS (require Royce's adjudication)

These cannot be resolved from the documents alone. Each needs a ruling before the
`SUPERSESSION_INDEX` can be generated.

**4.1 — Two numbering systems ran in parallel.** A family of briefs was issued with the
instruction *"assign next free git number"* and took numbers in git that the document series
had already used. Evidence:

- `..._VISIBLE_MODESWITCH_MATRIX.md` says *"Brief 27 fixed clean-slate-on-close"* — but
  `BRIEF_27_GUIDED_INTAKE.md` is the guided intake tool.
- `..._CLEAN_SLATE_ON_CLOSE.md` says *"Briefs 25/26 already did that [dedup guards]"* — but
  `BRIEF_25` is the anonymous tally and `BRIEF_26` is ZK custody.
- The trigger-unify refactor is recorded elsewhere as Brief 30 — but `BRIEF_30` is the
  signup gate.

**Ruling required:** which series is canonical. Recommendation — the **document series** is
canonical, and the git-numbered family is re-labelled with the `BRIEF_0NN` numbers they
should have had, recorded once in the index. Git history keeps its own commit numbering and
is not renumbered.

**4.2 — Brief 1 is two different briefs.** `BLACKBOX_FIX_BRIEF.md` (comprehensive P0–P2)
and `BRIEF_1_ACCOUNTS_VERIFY.md` ("Brief 1 of 4"). The latter belongs to a separate
four-part program (Accounts → Tenancy → Encryption → …). **Ruling required:** renumber the
4-part program into the main sequence, or name it as a distinct series with its own prefix.

**4.3 — Brief 15 is five documents**, and at least one is out of order:
`..._15_HIDDEN_MODE_TRIGGER_CLOSE.md` declares its floor as *"post Brief 16/17"*, so it is
chronologically later than 16 and 17 despite the number.

**4.4 — Brief 18 is two documents** (`_18.md`, `_18_VISIBLE_TRIGGER_AND_CHECKIN.md`).
**Ruling required:** which is authoritative.

**4.5 — Brief 29 is three documents**, two of them competing versions of the certified
report (`BLACKBOX_FIX_BRIEF_29_CERTIFIED_REPORT.md`, `BRIEF_29_CERTIFIED_REPORT__1_.md`).
**Ruling required:** which version is built.

**4.6 — Brief 23 (Tenancy) is absent** from the corpus. Briefs 24, 26, and 28 all gate on
it. **Ruling required:** locate it or rewrite it. Until then, three open briefs have an
unverifiable prerequisite.

**4.7 — Briefs 3 and 4 are absent.** Confirm whether they were allocated, or whether the
`#3` / `#10` item numbers inside `BLACKBOX_FIX_BRIEF.md` were mistaken for brief numbers.

---

## §5 — THE CHART AS CORRECTED

Consolidated current reading on every subject where a later brief changed an earlier one.
This is the section a new reader reads first.

| Subject | Current authoritative reading | Source |
|---|---|---|
| **Trigger** | One `triggerAlert()` core. Mode is display-only. Two racing paths no longer exist. Triggering is instant — no gates, no exceptions. | Trigger-unify, supersedes 18/22 |
| **Dispatch** | Sequential cascade in priority order. **10-second intervals**, full chain under 60s. Empty slots collapse and do not consume a window. Coordinator claim halts the cascade. | `cascade_and_line`, supersedes 11's 15s |
| **Contact ceiling** | **Two** — guardian plus one. | Supersedes 9's three-plus-guardian *(confirm)* |
| **Armed state** | Not Armed without at least one confirmed contact. Dispatch is gated on confirmed status. Text-based emergency-services fallback does not count toward Armed. | Current model |
| **Coordinator claim** | Explicit user interaction only. Never on passive GET or page load. | 7, locked |
| **Closure** | Consent scales to the parties actually engaged. **NOT BUILT** — dual-consent remains hardcoded to 2, and a solo survivor still has no consent path. | 0B, open |
| **Closure PIN** | Legacy 4-digit server pin retired. Any document describing PIN-based closure as current is stale. | 12, then dual-consent |
| **Check-in recipient** | User-designated contact. Not the guardian. | 19, supersedes 17 §1 |
| **Auth** | Passwordless. Passkey primary; magic-link fallback disabled once a passkey exists; recovery via keychain plus one-time code. Signup never depends on an outbound email succeeding. | Supersedes 14 |
| **Live-alert lock** | Settings, sign-out, and delete are blocked during an active alert, enforced server-side. | 20 |
| **Deploy currency** | Build IDs are compared. **Insufficient** — a build with no API origin passes the check. Corrected by Brief 35. | 21, corrected |
| **Encryption** | "Armed" does not currently mean encrypted; plaintext fallback is reachable on ordinary timing. Corrected by Brief 35. Until 35 ships, no document may state that capture is encrypted. | 26 / `..._ENCRYPTION.md`, corrected |
| **Vault retention** | The application is *designed to* retain sealed evidence for 36 months. Write-once is not enforced by the repository. Until Brief 39 provisions and verifies the bucket lock, no document may state "write-once." | 2 §C3, corrected |
| **Anti-truncation** | Not implemented. Exports include integrity records and sequence. No document may state "anti-truncation verified" until Brief 37 ships. | Corrected |
| **Chain of custody** | Four-step process (identity gate → authorization → assemble/seal → recorded transfer) is the design. Chain append is not concurrency-safe. Corrected by Brief 36. | 2 §C2, corrected |
| **Data custody** | The incident record belongs to the user. Never a BLACK BOX asset in any form. Operational counters only. | Locked principle |

---

## §6 — THE INDEX

Generate `SUPERSESSION_INDEX.md` at repository root, built from corrections blocks — never
hand-maintained.

- One row per correction: `Brief N §X → corrected by Brief M → current reading (first line)`
- Sorted newest-first, matching the reading order in §1
- Regenerated by a script in the pre-push gate; a corrections block that does not parse
  fails the push
- Seeded from §3 and §5 of this brief

Answering *"was Brief 12 §3 ever touched?"* must be one lookup, not a forward read through
the corpus.

---

## §7 — ACCEPTANCE

1. `STANDING_CONSTRAINTS.md` amended to carry §1 and §2 as non-negotiable.
2. Every brief from 35 forward opens with a corrections block, or is rejected.
3. `SUPERSESSION_INDEX.md` exists, is generated, and is seeded from §3 and §5.
4. The parser is wired into the pre-push gate and fails on a malformed block.
5. Each ruling in §4 is recorded in this file under a dated `## RULINGS` section appended
   below — this brief is the one document permitted to be amended in place, because it is
   the index of record.
6. Existing brief files are **not** rewritten. The ledger closes the gap; the history stays
   as it was written.

---

## RULINGS

*(Append as adjudicated. Format: date — §4.N — ruling.)*

**2026-08-02 — numbering — Fix-revision convention adopted.** A brief that fixes something a
prior brief shipped carries that brief's number with a revision suffix (`FIX_A`, `FIX_B`).
Only new capability takes a new number. Retro-applied to the unbuilt queue:

| Was | Now | Fixes |
|---|---|---|
| 49 | `BRIEF_033_FIX_A` | Brief 33 coordinator dashboard polling |
| 48 | `BRIEF_035_FIX_A` | Brief 35 gate, Brief 21 currency poll |
| 41 | `BRIEF_030_FIX_A` | Brief 30 signup gate |
| 42 | `BRIEF_002_FIX_A` | Brief 2 identity/event authority |
| 43 | `BRIEF_041` | New capability — abuse controls |
| 44 | `BRIEF_036_FIX_A` | Brief 36 §D degradation contract |
| 45 | `BRIEF_042` | New capability — headers, session rotation |
| 46 | `BRIEF_043` | New capability — request bounds, hostile input |
| 47 | `BRIEF_023_FIX_A` | Brief 23 tenancy |

**Numbers 44–49 are retired unissued.** They were allocated during audit-remediation planning
and never used. The gap is deliberate and recorded here so no future reader treats it as
missing documents.

**2026-08-02 — §1 — Bidirectional dependency links mandatory.** Every brief carries both
`**REQUIRES:**` and `## CARRIES FORWARD (open, owned by)`. See §2.

**2026-08-02 — §3, Brief 23 — Record reconstructed.** Brief 23's document remains absent, but
its record — what it built and what it left incomplete — is captured in `BRIEF_023_FIX_A` §0.
The corpus gap is closed there.
