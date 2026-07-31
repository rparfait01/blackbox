# BRIEF 37 — INTEGRITY CHAIN: SERIALIZE APPENDS, NEVER CONCEAL A COLLISION

**Type:** FIX
**Priority:** P0 — RELEASE BLOCKER
**Floor:** Brief 35 (`a098327`) and Brief 36 (`13c539f`) shipped. Zero regression to trigger,
capture, upload, closure, custody export, the deploy gate, the readiness panel, the cascade
DO alarm, or the bounded cron.
**Mode:** proven on deployed production under **concurrent** load, not sequential.
**Server-side only.** No device dependency. Runs in parallel with the outstanding Brief 36
render work and the device session.
**Audit ref:** Pass 1 Finding 3 · Pass 2 Finding 3 (Confirmed — P0)

---

## CORRECTIONS

*Ordered newest brief first.*

**BRIEF 036 §B — corrected to read:**
"`PREPARING` and `FAILED_RETRYABLE` hold. `READY` encrypts and transmits. `FAILED_TERMINAL`
**transmits and declares** — the chunk is marked `UNENCRYPTED_DECLARED` server-side, the
survivor is warned in overt mode and signalled covert-safely in Hidden, and an operator alert
fires at error level. A missing key is never terminal: the device mints and publishes a
keypair on demand. Capture availability outranks confidentiality where the two genuinely
compete."
Path: `apps/pwa/src/lib/upload/upload-manager.ts`

**BRIEF 036 §A — corrected to read:**
"Encryption state is derived server-side from inspection of the received bytes, never from a
client-supplied header. `UNENCRYPTED_UNDECLARED` is an alertable condition."
Path: `workers/api/src/index.ts`

**BRIEF 002 §C2 — corrected to read:**
"The custody chain is never purged. Only the objects it attests to may be purged, and only on
recorded owner consent. Deleting evidence and erasing the record that evidence existed are
different acts; the second is never performed."
Path: `workers/api/src/lib/integrity.ts`

**BRIEF 002 §C2 — corrected to read:**
"Integrity records for one event are appended through a single serialization point. Sequence
allocation, record insertion, and head advancement occur as one indivisible operation. A
sequence collision is an error condition that fails the request — it is never ignored."
Path: `workers/api/src/lib/integrity.ts`

**BRIEF 002 §C2 — corrected to read:**
"The signed chain head always corresponds to a record that exists in the chain."
Path: `workers/api/src/lib/integrity.ts`

---

## THE DEFECT (settled — do not re-diagnose)

Each append reads the current head, computes `seq + 1`, then issues a D1 batch containing an
`INSERT OR IGNORE` for the record and an unconditional upsert of the head.

`D1Database.batch()` is transactional, but **`getHead()` runs outside it.** The read-modify-
write race is not closed.

Two overlapping requests for the same event both read head `seq=5`. Both compute sequence 6
with different record hashes. A inserts record 6A and sets the head to 6A. B's insert is
silently ignored — and B still unconditionally sets the head to 6B. **The signed head now
refers to a record that was never inserted.**

This requires no attacker. Media chunks, commitments, and other uploads are independent HTTP
requests; overlap is normal. A legitimate capture produces an unverifiable export.

---

## §0 — PRECONDITION: DO ALARM CONTENTION `[A]`

Brief 36 §11 moved the cascade tail onto a Durable Object alarm and bounded cron at 20s per
job. This brief introduces a per-event DO for chain appends.

**Before building §A:** determine whether the cascade tail and the integrity DO would share
an alarm channel for the same event. A DO has one alarm. Two consumers means one silently
displaces the other, and the displaced one is the audit tail — the exact failure §11 just
fixed.

Resolve one of two ways and state which in the report:

- Separate DO namespaces — cascade and integrity are distinct objects for the same event; or
- One DO, one alarm, an internal queue that services both tails in order.

Do not proceed until this is answered on captured evidence, not inspection.

## §A — SERIALIZATION `[A]`

Choose one and implement it fully. Do not hybridize.

**Preferred — per-event Durable Object.** One DO instance per event ID owns integrity
appends. All appends route through it. Serialization is structural rather than optimistic.

**Alternative — compare-and-swap loop.** The head update succeeds only when the prior
sequence and prior hash both match what was read. On mismatch, re-read and retry with bounded
attempts. On exhaustion, fail the request loudly.

If the DO route is taken, its responsibility is bounded — see §D.

## §B — COLLISIONS FAIL LOUD `[A]`

- Remove `INSERT OR IGNORE` from the integrity path. A record insert that conflicts is an
  error.
- The head advances only together with a record that was actually inserted, in one indivisible
  operation.
- A collision returns a distinguishable error to the caller and writes an operator-visible
  audit row. It is never swallowed and never retried blind.
- **A failed integrity append must not fail the capture.** The chunk still uploads and the
  evidence is still retained; the chain records a declared gap. Losing evidence to protect a
  hash chain inverts the priority. Model the gap explicitly so a verifier reports "chain
  incomplete at sequence N" rather than silently producing a short chain.

## §C — IDEMPOTENCY SURFACE `[A]`

The serialization point is where replay protection belongs. Build the surface now, even
though the credential that uses it arrives in Brief 42.

- Accept an idempotency key on integrity-bearing writes.
- A repeated key returns the original result without appending a second record.
- Keys are scoped to the event and expire with it.

Do not implement device credentials here. Brief 42 consumes this surface.

## §D — BOUNDARY (non-negotiable) `[A]`

If a per-event Durable Object is used, it owns **event-scoped concerns only**:

- integrity appends
- replay and idempotency for those appends
- event-scoped command ordering

It does **not** own, mint, store, rotate, or revoke device or account identity. Credential
provisioning stays in the identity boundary with Brief 41. The event DO may *validate* an
event-scoped signed request; it may not be the source of the credential it validates.

One DO must not become an oversized security monolith. State this boundary in the DO's own
header comment so the next contributor inherits it.

## §E — VERIFIER ALIGNMENT `[A]`

The standalone verifier distinguishes four outcomes and reports them distinctly:

| Outcome | Meaning |
|---|---|
| `VERIFIED` | Chain complete and internally consistent; attested objects present |
| `INCOMPLETE` | Declared gap at a known sequence, per §B |
| `PURGED_BY_CONSENT` | Chain intact; attested objects deliberately destroyed on recorded owner consent |
| `BROKEN` | Head does not correspond to a stored record, or a hash mismatch |

**`PURGED_BY_CONSENT` is mandatory and not optional.** Production currently holds 63 chain
records attesting to 62 objects purged at `13c539f`. Without this outcome the first export off
production reads as tampered. It is verified against the `chunks.purged_owner_consent` audit
row, which names the D1 restore point and the export manifest.

These four are different findings. Collapsing any two destroys the diagnostic value of the
chain.

---

## ACCEPTANCE

Sequential proof is not proof. Every item below runs concurrently against production.

1. §0 answered on captured evidence; the resolution stated in the report.
2. Fire N ≥ 20 genuinely concurrent integrity-bearing writes for one event. All records
   present, sequences contiguous, head matches the last stored record. Query and screenshot.
3. Repeat across five separate events simultaneously. No cross-event interference.
4. Export a fresh capture and run the standalone verifier. Result is `VERIFIED`.
5. Export one of the five purged events. Result is `PURGED_BY_CONSENT` — not `BROKEN`,
   not `VERIFIED`. Screenshot.
6. Force a collision deliberately. It surfaces as an error and an audit row — never silent.
   The capture continues and the chunk still uploads.
7. Force a chain gap. Export verifies as `INCOMPLETE` naming the sequence.
8. Replay an idempotency key. One record, original result returned.
9. Cascade regression: under concurrent integrity load, `cascade_step_undelivered` remains
   5-of-5 and the audit tail is not truncated. This is the §11 fix; do not regress it.
10. Bounded cron still completes all 8 jobs within budget under the same load.
11. Full acceptance suite re-run, 90/90, all prior greens still pass.

---

## THIS BRIEF DOES NOT CLOSE

- The terminal-chunk marker. A concurrency-safe chain with no terminal marker still cannot
  prove completeness. **Brief 38.**
- Verification key provenance. A correct chain verified against an attacker-supplied key
  proves nothing. **Brief 39.**
- Vault immutability and scan coverage. **Brief 40.**
- Device credentials. This brief builds the surface; **Brief 42** supplies the credential.
- Brief 36's outstanding §D render, §E endpoint, and §F canary traversal.
- Brief 35 item 7 and Brief 36 items 1/2/4/5/7 — device session.
