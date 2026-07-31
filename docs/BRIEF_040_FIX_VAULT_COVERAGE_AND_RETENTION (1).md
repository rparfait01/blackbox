# BRIEF 40 — VAULT: FULL SCAN COVERAGE AND VERIFIED RETENTION

**Type:** FIX
**Priority:** P1 — blocks every retention and write-once claim
**Gate:** Brief 39 shipped. Retention is meaningless on objects whose origin cannot be
established.
**Floor:** Briefs 35–39. Zero regression to trigger, capture, upload, closure, export, deploy
gate, readiness panel, cascade DO alarm, integrity DO, bounded cron, or the consented-purge
path shipped at `13c539f`.
**Mode:** server-side and infrastructure. **No device dependency.**
**Audit ref:** Pass 1 Findings 6, 7 · Pass 2 Findings 6, 7 (Confirmed — P1)

---

## CORRECTIONS

**BRIEF 002 §C3 — corrected to read:**
"Sealed evidence is retained under a storage-layer retention rule, scoped to the vault prefix,
with a stated duration. The rule is provisioned as infrastructure and verified at deploy time
by reading the live configuration back. Metadata fields, comments, and application-level
checks asserting a retention period are not retention."
Path: `infra/`, `scripts/deploy.mjs`

**BRIEF 002 §C3 — corrected to read:**
"The vault sealing scan covers every eligible object. Coverage is proven by a durable cursor,
not bounded by a per-run object cap."
Path: `workers/api/src/cron/vault-scan.ts`

**BRIEF 034 §5 (Vault retention) — corrected to read:**
"Sealed evidence is retained for 36 months under a verified storage-layer retention rule."
*Effective only when this brief's acceptance is green. Until then the Brief 34 §5 reading
stands and no document may use the phrase "write-once."*

---

## THE DEFECT (settled — do not re-diagnose)

**Finding 6 — starvation.** The vault sealing scan processes a capped batch per run. Once
eligible objects exceed the cap, the same head of the list is reprocessed every run and the
tail is never reached. Coverage silently becomes partial, and the objects that go unsealed are
the oldest — the ones closest to needing the retention guarantee.

**Finding 7 — unprovisioned lock.** No repository artifact establishes that an R2 bucket-lock
or retention rule exists on production. Retention is asserted in application metadata and in
customer-facing documents. Neither can prevent a deletion.

Together: the vault is a naming convention, not a retention guarantee.

---

## §0 — PRECONDITION: RETENTION VERSUS OWNER PURGE `[A]`

**Do not provision any lock until this is answered in writing.** An irreversible compliance
lock on survivor data is not something that can be undone by a later brief.

Two commitments are in direct conflict:

- **The retention claim.** Sealed evidence survives 36 months and cannot be deleted — which is
  what makes it evidence rather than a file the operator could quietly remove.
- **The locked data-custody principle.** The incident record belongs to the user and is never a
  BLACK BOX asset. At `13c539f` an owner-consented purge destroyed 62 objects, and that path is
  shipped and correct.

A true compliance-mode lock would have made that purge impossible. It would also mean a
survivor cannot delete her own recordings — which inverts the principle the product is built
on, and creates a live safety problem: a survivor who wants her evidence gone and finds she
cannot delete it is worse off than before she used the tool.

Determine and state:

1. Which retention modes R2 actually offers, and which are reversible by the account holder.
2. Whether a mode exists that resists **operator** deletion while permitting an
   **owner-directed, chain-recorded** purge. Brief 37 §E already supports this outcome —
   `PURGED_BY_CONSENT` with an audit row naming the restore point.
3. If no such mode exists, present the choice explicitly. Do not pick for Royce, and do not
   provision a compliance lock as a default.

**Recommended framing:** the lock exists to bind the operator, not the owner. That is the
honest version of the claim, it is what an institutional buyer's counsel actually needs, and
it is compatible with the custody principle. If the storage layer cannot express it, the
customer-facing language changes rather than the principle.

## §A — SCAN COVERAGE `[A]`

- Replace the per-run object cap with a durable cursor that advances across runs until the
  eligible set is exhausted, then resets.
- A full pass is a recorded event: start, end, objects examined, objects sealed.
- **Backlog is alertable.** If eligible objects grow faster than they are sealed across N
  consecutive passes, raise an operator alert at error level. Silent partial coverage is the
  defect; a cursor that falls behind unobserved reproduces it.
- Respect the 20s per-job cron bound from Brief 36 §11. The cursor exists so that a bounded job
  and full coverage are compatible — do not lift the bound.
- The readiness panel reports vault coverage the same way it reports encryption: objects
  eligible, objects sealed, oldest unsealed object age.

## §F — SEALING IS AUTOMATIC, NOT CONTINGENT `[A]`

**Preempts §B and §C.** Locking and verifying a retention rule over a bucket nothing writes to
is finding 7 in a third costume.

`exportPackage` is the sole writer of the vault and is reachable only from
`GET /v1/c/:id/export`, behind a verified-recipient gate that has never been passed in
production. Nothing seals on close and nothing seals on a timer. A survivor's evidence is
sealed only if some third party later completes an identity ceremony and chooses to export.
That is a gap between what the vault is described as and what it does.

**The rule: every event that reaches a terminal state is sealed, by the server, without any
third party's participation.**

### F1 — Trigger on every terminal state

Sealing fires on all of: user-initiated close, dual-consent close, feed-loss close, orphan
close, admin force-close, lifecycle timeout. **The abnormal terminations matter most** — a
seized phone is the threat model, and that event must seal without anyone acting.

### F2 — Closure never waits on sealing

Closure is safety-critical and completes on its own path. Sealing is enqueued as a durable
`seal_pending` state on the event and drained asynchronously. A sealing failure never fails,
delays, or reverses a closure.

### F3 — Drain with a cursor, bounded

- Cron pass over `seal_pending` events using the §A cursor pattern: primary-key walk, advance
  past a failed item so one bad event cannot wedge the queue.
- Respects the Brief 36 §11 20s per-job bound. Do not raise it.
- **Not on the integrity DO** — Brief 37 §D boundary holds. Separate concern, separate owner.

### F4 — Idempotent

One seal per event, keyed by event id. A second attempt is a no-op returning the existing
manifest. Re-export never re-seals. A purged event's manifest is not regenerated.

### F5 — Export reads, never writes

`exportPackage` is split: sealing writes the manifest; export retrieves it. Recipient
verification continues to gate **access** to the artifact — it no longer gates the artifact's
**existence**. An unverified recipient still gets 403; the seal exists regardless.

### F6 — Backfill

Seal the 5 existing closed production events. Their media is purged, so their manifests attest
to objects deliberately destroyed on consent — export reads `PURGED_BY_CONSENT` (Brief 37 §E),
which is the correct and already-built outcome. Restore point first.

### F7 — Fail loud

- A closed event unsealed beyond a stated threshold raises an error-level alert.
- Readiness panel reports: events pending seal, oldest unsealed closed event, seal failures.
- Sealing failure is retryable and audited. Never silent, never a silent drop.



Subject to §0's answer.

- Provisioned as tracked infrastructure configuration, not by hand in a dashboard.
- Prefix-scoped to the vault path only. It must not apply to working chunk storage, canary
  objects, or the consented-purge path.
- Duration matches the stated period exactly.

## §C — VERIFY IT AT DEPLOY `[A]`

- The deploy gate reads the **live** rule back from the storage API and asserts: rule present,
  prefix coverage correct, duration correct.
- Deploy fails on absent, mis-scoped, or shortened rule.
- This joins the Brief 35 gate rather than replacing it. Same fail-closed posture, same clear
  message naming what is wrong.
- Comments, metadata columns, and application-level assertions do **not** satisfy §C. The
  assertion reads the live configuration or it does not exist.

## §D — STATE THE LIMITS HONESTLY `[A]`

Write into the code and the report what the retention rule does and does not prevent. At
minimum: whether it survives bucket deletion, account-level action, and billing lapse.

A retention guarantee that would not survive the operator closing the account is a different
and weaker claim than the one currently written in customer-facing material. Say which one is
true. Brief 38 §B set the precedent — bound the claim in code rather than letting the wording
imply more than the design delivers.

## §E — PURGE PATH COMPATIBILITY `[A]`

- The consented-purge path shipped at `13c539f` must still function after §B, exactly as §0
  resolves it.
- Regression: run a consented purge on a staging event post-provisioning. It succeeds, writes
  its audit row, and the export reads `PURGED_BY_CONSENT` — not an error, not a silent
  no-op.
- If §0 concludes the two are irreconcilable, this section becomes the record of that
  conclusion and the customer-facing language changes instead.

---

## ACCEPTANCE

Server-side and infrastructure. No device required.

1. §0 answered in writing, with the R2 modes named and the operator-versus-owner distinction
   resolved. **No lock is provisioned before this item is signed off by Royce.**
2. **§F1:** each terminal state seals — user close, dual-consent close, feed-loss, orphan close,
   admin force-close, lifecycle timeout. Six events, six manifests. Query and screenshot.
3. **§F2:** induce a sealing failure mid-close. Closure completes normally, event is
   `seal_pending`, cascade and closure unaffected.
4. **§F3:** seed more pending seals than one pass can drain. Cursor advances, all drain across
   passes, cron stays inside the 20s bound. Include one deliberately unsealable event; confirm
   it does not wedge the queue.
5. **§F4:** seal twice → one manifest. Export twice → no re-seal.
6. **§F5:** unverified recipient → 403, and the manifest exists anyway. Verified recipient →
   retrieves the same manifest, does not create one.
7. **§F6:** the 5 production events sealed; export reads `PURGED_BY_CONSENT`. Restore point
   recorded.
8. **§F7:** unsealed-beyond-threshold alert fires; readiness panel reports all three metrics.
9. Seed the vault past the old cap. A full §A pass reaches every object. Screenshot coverage.
10. Cursor survives a cron run boundary and resumes without reprocessing the head.
11. Backlog alert fires when eligible growth outpaces sealing across consecutive passes.
12. Cron completes all jobs within the 20s per-job bound under seeded load.
13. Retention rule provisioned per §0's resolution, prefix-scoped, correct duration.
14. Deploy gate reads the live rule back and passes.
15. Mis-scope the prefix → deploy **fails**, naming the mismatch. Restore → passes.
16. Shorten the duration → deploy **fails**.
17. Consented purge on staging post-provisioning still succeeds; export reads
    `PURGED_BY_CONSENT`.
18. §D's limits written into the report in plain language.
19. Readiness panel reports vault coverage alongside encryption status.
20. Trigger, capture, closure, cascade unaffected throughout.
21. Full acceptance suite re-run, 90/90, all prior greens still pass.

---

## THIS BRIEF DOES NOT CLOSE

- Auth hardening. **Briefs 41–43.**
- Storage health, queue budget, dead-letter. **Brief 44.**
- Tenant attribution on vault objects and custody transfers — the vault is keyed by event with
  no org column. **Brief 47.**
- Brief 36 acceptance item 12 and the outstanding device session.
