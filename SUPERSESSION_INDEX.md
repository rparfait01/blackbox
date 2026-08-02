# SUPERSESSION INDEX

**Generated — do not edit.** `node scripts/supersession-index.mjs`

Built from the `## CORRECTIONS` blocks in `docs/BRIEF_*.md` (Brief 34 §6). Sorted newest-first,
matching the reading order in Brief 34 §1: read down until the picture is complete, then stop.

Answering "was Brief 12 §3 ever touched?" is one lookup here, never a forward read.

## Corrections (from Brief 35 forward)

| Corrected | By | Current reading (first line) | Path |
|---|---|---|---|
| Brief 002 §C3 | Brief 040 | Sealed evidence is retained under a storage-layer retention rule, scoped to the vault prefix, | — |
| Brief 002 §C3 | Brief 040 | The vault sealing scan covers every eligible object. Coverage is proven by a durable cursor, | — |
| Brief 034 §5 (Vault retention) | Brief 040 | Sealed evidence is retained for 36 months under a verified storage-layer retention rule. | — |
| Brief 002 §C2 | Brief 039 | The verifier establishes signer identity from a trust root it carries independently of the | — |
| Brief 034 §5 (Chain of custody) | Brief 039 | Exports are signed, and the verifier reports which signer key validated them, by fingerprint, | — |
| Brief 002 §C2 | Brief 038 | A capture that terminates normally carries an authenticated terminal marker on its last | — |
| Brief 034 §5 (Anti-truncation) | Brief 038 | Exports distinguish complete captures from truncated captures. A normally terminated capture | — |
| Brief 036 §B | Brief 038 | `PREPARING` and `FAILED_RETRYABLE` hold. `READY` encrypts and transmits. `FAILED_TERMINAL` | — |
| Brief 037 §E | Brief 038 | The verifier reports five outcomes: `VERIFIED`, `INCOMPLETE`, `PURGED_BY_CONSENT`, `BROKEN`, | — |
| Brief 002 §C2 | Brief 037 | The custody chain is never purged. Only the objects it attests to may be purged, and only on | — |
| Brief 002 §C2 | Brief 037 | Integrity records for one event are appended through a single serialization point. Sequence | — |
| Brief 002 §C2 | Brief 037 | The signed chain head always corresponds to a record that exists in the chain. | — |
| Brief 036 §B | Brief 037 | `PREPARING` and `FAILED_RETRYABLE` hold. `READY` encrypts and transmits. `FAILED_TERMINAL` | — |
| Brief 036 §A | Brief 037 | Encryption state is derived server-side from inspection of the received bytes, never from a | — |
| Brief 026 §CUSTODY MODEL | Brief 036 | No evidence chunk transmits from the device in any state other than READY. Encryption is a | — |
| Brief 026 §CUSTODY MODEL | Brief 036 | The alert path — event creation, contact dispatch, location, heartbeat, closure — never | — |
| Brief 026 §CUSTODY MODEL | Brief 036 | Every chunk carries a server-verifiable encryption state. The server rejects a chunk whose | — |
| Brief 034 §5 (Encryption) | Brief 036 | Capture is encrypted before transmission. Plaintext chunks are not reachable on any path. | — |
| Brief 035 §D | Brief 036 | Dispatch suppression requires two conditions, both re-derived server-side at dispatch time: | — |
| Brief 035 §C | Brief 036 | The canary reserved contact number is `+14155550199`. The reserved block is exchange 555 | — |
| Brief 035 §C | Brief 036 | The canary resolves the deployed version through the same fail-closed poller the currency | — |
| Brief 021 §1 | Brief 035 | Deploy currency requires three conditions, all enforced before publish: the PWA and Worker | — |
| Brief 021 §1 | Brief 035 | A production build with no API origin is not a degraded build. It is a build in which the | — |

## Pre-34 ledger (seeded from Brief 34 §3 and §5)

These predate the corrections convention. The briefs that made them are **not rewritten**
(Brief 34 §7.6) — this table is how their history survives.

| Subject | Corrected | By | Current authoritative reading |
|---|---|---|---|
| Trigger | — | Trigger-unify | One triggerAlert() core. Mode is display-only. Triggering is instant — no gates. |
| Dispatch | 011 | cascade_and_line | Sequential cascade, 10-second intervals, full chain under 60s. Coordinator claim halts it. |
| Contact ceiling | 009 | later decision | Two — guardian plus one. (Confirm.) |
| Armed state | — | current model | Not Armed without at least one confirmed contact. Text-based emergency fallback does not count. |
| Coordinator claim | 007 | 007 (locked) | Explicit user interaction only. Never on passive GET or page load. |
| Closure | 0B | 0B (open) | Consent scales to engaged parties. NOT BUILT — dual-consent remains hardcoded to 2. |
| Closure PIN | 012 | 012, then dual-consent | Legacy 4-digit server pin retired. Any document describing PIN-based closure is stale. |
| Check-in recipient | 017 §1 | 019 | User-designated contact. Not the guardian. |
| Auth | 014 | passwordless rebuild | Passkey primary; magic-link disabled once a passkey exists. Signup never depends on outbound email. |
| Live-alert lock | — | 020 | Settings, sign-out and delete are blocked during an active alert, enforced server-side. |
| Deploy currency | 021 | 035 | Build IDs alone are insufficient — a build with no API origin passed. Corrected by 035. |
| Encryption | 026 | 036 | "Armed" did not mean encrypted; plaintext fallback was reachable on ordinary timing. |
| Vault retention | 002 §C3 | 040 | Designed to retain 36 months. Write-once is NOT enforced by the repository. |
| Anti-truncation | — | 038 | Exports include integrity records and sequence. Not verified until 038 ships. |
| Chain of custody | 002 §C2 | 037 | Four-step design. Chain append was not concurrency-safe. Corrected by 037. |
| Data custody | — | locked principle | The incident record belongs to the user. Never a BLACK BOX asset in any form. |

## Corpus notes

Recorded rather than silently tolerated. Collisions are Brief 34 §4 items and need adjudication.

- DUPLICATE brief number 40: BRIEF_040_FIX_VAULT_COVERAGE_AND_RETENTION (1).md and BRIEF_040_FIX_VAULT_COVERAGE_AND_RETENTION.md (recorded, not fatal)
- DUPLICATE brief number 26: BRIEF_26_REVIEW_ANSWERS.md and BRIEF_26_ZK_CUSTODY.md (recorded, not fatal)
- DUPLICATE brief number 29: BRIEF_29_CERTIFIED_REPORT (1).md and BRIEF_29_CLOSING.md (recorded, not fatal)

