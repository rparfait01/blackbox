# BRIEF 38 — TERMINAL CHUNK: MAKE COMPLETENESS PROVABLE

**Type:** FIX
**Priority:** P1 — blocks all completeness and anti-truncation claims
**Gate:** Briefs 36 and 37 both green in production. Depends on the encryption AAD pipeline
(36) and a concurrency-safe chain (37). Do not begin earlier.
**Floor:** Briefs 35–37. Zero regression to trigger, capture, upload, closure, export, the
deploy gate, the readiness panel, the cascade DO alarm, or the bounded cron.
**Mode:** proven on deployed production, both Present modes, on real captures.
**Audit ref:** Pass 1 Finding 5 · Pass 2 Finding 5 (Confirmed — P1)

---

## CORRECTIONS

*Ordered newest brief first.*

**BRIEF 037 §E — corrected to read:**
"The verifier reports five outcomes: `VERIFIED`, `INCOMPLETE`, `PURGED_BY_CONSENT`, `BROKEN`,
and — orthogonally to all four — a per-capture completeness state of `COMPLETE`, `ABNORMAL`,
or `IN_PROGRESS`. Chain integrity and capture completeness are independent axes and are
reported separately. A purged capture still carries the completeness state it had at purge."
Path: `tools/verifier/`

**BRIEF 036 §B — corrected to read:**
"`PREPARING` and `FAILED_RETRYABLE` hold. `READY` encrypts and transmits. `FAILED_TERMINAL`
transmits and declares. A missing key is never terminal: the device mints and publishes a
keypair on demand. Capture availability outranks confidentiality where the two genuinely
compete."
Path: `apps/pwa/src/lib/upload/upload-manager.ts`

**BRIEF 002 §C2 — corrected to read:**
"A capture that terminates normally carries an authenticated terminal marker on its last
chunk. A capture that terminates abnormally carries a declared abnormal-termination state and
no terminal marker. These two outcomes are distinguishable in the export."
Path: `apps/pwa/src/lib/capture/media-capture.ts`, `apps/pwa/src/lib/upload/upload-manager.ts`

**BRIEF 034 §5 (Anti-truncation) — corrected to read:**
"Exports distinguish complete captures from truncated captures. A normally terminated capture
is provably complete."
*Effective only when this brief's acceptance is green. Until then the Brief 34 §5 reading
stands and no document may state that anti-truncation is verified.*

---

## THE DEFECT (settled — do not re-diagnose)

`sendItem()` calls `sealChunkForSend()` with `isFinal: false` on every chunk without
exception. `X-Is-Final` is therefore never `1`, every database row receives `isFinal=0`, and
report generation always returns `finalChunkPresent: false`.

The schema, the header, the AAD field, and the report field all exist. Nothing ever produces
the value.

Consequence: **every real capture appears truncated.** A capture that ended normally and a
capture whose tail was silently lost are indistinguishable by the mechanism built to
distinguish them. The documented admissibility property does not function.

---

## §A — IDENTIFY THE ACTUAL LAST CHUNK `[A]`

- On recorder stop, the last `dataavailable` payload is the terminal chunk. Mark it as such
  at the point of production, in the capture layer — not inferred later by the upload layer.
- The marker travels with the queue item through persistence. A queue that survives a page
  termination must not lose it.
- If the recorder stops with no trailing payload, the preceding chunk is marked terminal and
  the reason is recorded.

## §B — AUTHENTICATE IT `[A]`

- `isFinal` is authenticated as AAD in the same seal operation Brief 36 established. A
  terminal marker that is not authenticated is worthless — it can be stripped or forged.
- The server persists the terminal state from the authenticated envelope, never from a bare
  header. `X-Is-Final` may route; it must not be trusted.
- The terminal record is appended to the integrity chain through the Brief 37 serialization
  point.
- **`UNENCRYPTED_DECLARED` interaction:** a chunk transmitted under Brief 36's
  `FAILED_TERMINAL` path has no authenticated envelope, so its terminal marker cannot be
  authenticated. Such a capture reports `COMPLETE (UNAUTHENTICATED MARKER)` — never plain
  `COMPLETE`. The distinction appears in the export and the report. Do not silently downgrade
  it to `ABNORMAL`; the capture did end normally, and saying otherwise is its own dishonesty.

## §C — ORDERING `[A]`

The terminal marker only means something if it arrives last.

- The upload queue preserves ordering within a capture.
- A terminal chunk that would be delivered before an earlier chunk is held until the earlier
  chunk is acknowledged.
- If an earlier chunk is permanently undeliverable, the capture is `ABNORMAL` (§D) — it is
  not silently marked complete because the last chunk happened to arrive.

## §D — MODEL ABNORMAL TERMINATION EXPLICITLY `[A]`

Abnormal termination is normal in this product. A device seized, destroyed, or with its
battery pulled mid-event is the threat model, not an edge case. **Absence of a terminal
marker must never be reported as a defect or as tampering.**

Per-capture completeness state:

| State | Meaning |
|---|---|
| `COMPLETE` | Normal stop, authenticated terminal marker present, ordering intact |
| `COMPLETE (UNAUTHENTICATED MARKER)` | Normal stop under Brief 36 `FAILED_TERMINAL`; marker present but unauthenticated |
| `ABNORMAL` | Capture ended without a normal stop. No terminal marker expected. Declared, with the last known sequence. |
| `IN_PROGRESS` | Capture is live |

- `ABNORMAL` is set by the server on lifecycle timeout or heartbeat loss — it must not depend
  on the device, because the device is the thing that stopped.
- The export and the report state which applies, in plain language.
- The verifier reports `ABNORMAL` as a factual outcome, not a failure. A survivor whose phone
  was taken has not produced defective evidence.
- Completeness state is **orthogonal** to Brief 37's chain outcome. A purged capture retains
  the completeness state it held at purge, and the export shows both axes.

## §E — REPORT LANGUAGE `[A]`

The report renders one of:

- "Capture ended normally. All recorded segments are present and accounted for."
- "Capture ended normally. All recorded segments are present. Segment integrity for this
  capture could not be cryptographically authenticated."
- "Capture ended without a normal stop at [DTG]. Segments through sequence N are present.
  Segments after that point, if any, were not received."
- "Capture in progress."

No document, report, or customer-facing material may use the phrase "anti-truncation
verified" until this brief is green.

---

## ACCEPTANCE

Each on the deployed app, both Present modes, on real captures.

1. Normal capture with a normal stop. Terminal marker present and authenticated. Report reads
   `COMPLETE`. Query the row and screenshot.
2. Capture under Brief 36 `FAILED_TERMINAL`. Report reads `COMPLETE (UNAUTHENTICATED
   MARKER)` — not `COMPLETE`, not `ABNORMAL`.
3. Kill the app mid-capture. Report reads `ABNORMAL` with the correct last sequence. Verifier
   does **not** report a defect or tampering.
4. Strip or forge the terminal marker on a crafted request. The server rejects it — the
   authenticated envelope, not the header, decides.
5. Deliver the terminal chunk out of order. It is held. Ordering preserved in the export.
6. Permanently fail an early chunk. Capture reports `ABNORMAL`, never `COMPLETE`.
7. Export a `COMPLETE` and an `ABNORMAL` capture. The verifier distinguishes them, and
   distinguishes both from `BROKEN` and `PURGED_BY_CONSENT` (Brief 37 §E).
8. Export a purged capture. Both axes render: chain outcome `PURGED_BY_CONSENT`, completeness
   state as held at purge.
9. Real end-to-end: trigger, cascade, contacts receive, capture, normal close, export
   verifies `COMPLETE`. **Screenshot the delivery.**
10. Full acceptance suite re-run, 90/90, all prior greens still pass.

---

## THIS BRIEF DOES NOT CLOSE

- Verification key provenance — a complete capture verified against a self-supplied key still
  proves nothing about origin. **Brief 39.**
- Vault immutability and scan coverage. **Brief 40.**
- Whether the retained evidence is confidential. **Brief 36** owns that; this brief assumes it.
- Arming `REQUIRED`. **Brief 47.**
