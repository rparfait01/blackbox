# BRIEF 36 FIX A — STORAGE HEALTH AND QUEUE MANAGEMENT

**Type:** FIX A on Brief 36 (encryption state machine — §D declared the degradation contract)
**Priority:** P1
**REQUIRES:** Brief 36 green including §D's degradation contract and §G; Brief 37 green (§F3
verifies the eviction/`INCOMPLETE` interaction); Brief 33 Fix A green.
**Ship order:** SEVENTH.
**Floor:** Briefs 35–41. Zero regression to trigger, capture, upload, closure.
**Mode:** device session required — quota exhaustion and storage denial cannot be simulated
headlessly.
**Audit ref:** Pass 1 Findings 2, 14 · Pass 2 Findings 2, 14 (Confirmed — P1)

---

## CORRECTIONS

**BRIEF 036 §D — corrected to read:**
"Brief 36 §D defines the degradation contract: which conditions constitute degradation and how
they are surfaced. Queue budgeting, eviction, dead-letter handling, and quota telemetry are
governed by this fix. The contract and its enforcement are separate concerns."
Path: `apps/pwa/src/lib/upload/queue.ts`

---

## THE DEFECT

**Finding 2 — silent storage failure.** IndexedDB write failures are not propagated. A device at
quota, in private browsing, or under storage pressure records to nowhere while the UI shows an
active capture. Brief 36 §D declared the degradation state; nothing measures the condition that
should raise it.

**Finding 14 — unbounded retry queue.** No limit, no dead-letter path. A long offline event
accumulates until the write that fails is the one carrying evidence.

Together: the on-device mirror of the Brief 35 defect. The app appears to be working.

---

## §A — MEASURE STORAGE

- Probe available quota at arm time and periodically during capture, not only on failure.
- Every IndexedDB write result checked. A failure raises Brief 36 §D degradation — never
  swallowed.
- Report device storage state with the event so the coordinator view reflects it.

## §B — BUDGET THE QUEUE

- Stated byte and item ceilings. Name the numbers.
- **Eviction on ceiling: evict oldest, never newest.** The most recent audio is the most probative
  and closest to the survivor's current situation.
- Eviction is a declared loss — degradation state, operator alert, recorded in the report. Never
  silent.

## §C — DEAD-LETTER

- Items failing beyond a stated retry ceiling move to a dead-letter store rather than retrying
  forever or vanishing.
- Dead-lettered items are surfaced, countable, and re-drivable on reconnect.
- **Dead-lettering is never the same event as deletion.**

## §D — TELEMETRY

- Readiness panel: devices reporting storage pressure, queue depth distribution, dead-letter
  counts.
- Sustained dead-lettering on one account alerts at error level.

## §E — ARM-TIME HONESTY

If a device cannot store at arm time, say so **before** the survivor relies on it. Overt: plain
warning. Covert: the Brief 36 §D cadence signal, same mapping. **Do not invent a second signal
vocabulary.**

## §F — ANTICIPATED GAPS

1. **Retry cost.** An unbounded retry queue against a failing Worker is the Brief 33 Fix A
   self-sustaining shape on the device side. Retries use exponential backoff with a cap, and stop
   entirely on a terminal server response.
2. **Quota probe accuracy.** `navigator.storage.estimate()` is advisory and wrong on iOS Safari.
   Treat a failed write as authoritative over any estimate; the estimate informs the arm-time
   warning only.
3. **Eviction versus the integrity chain.** An evicted chunk was already chain-appended. The
   export must read `INCOMPLETE` at that sequence (Brief 37 §B), not `BROKEN`. Verify this
   interaction explicitly.
4. **Private browsing arms silently today.** Confirm whether arming currently succeeds with no
   persistent storage at all. If it does, that is a Not-Ready state, not a supported one.

---

## ACCEPTANCE

1. Fill storage to quota, then capture → degradation raised, warning shown (both modes), server
   records it, **alert still fires and contacts still receive.** Screenshot the delivery.
2. Private browsing / storage denied → same, and the arm-time warning appears before trigger.
3. Queue past the byte ceiling → oldest evicted, newest retained, loss declared.
4. Evicted chunk → export reads `INCOMPLETE` at that sequence, not `BROKEN`.
5. Exceed retry ceiling → dead-letter, surfaced and countable, not deleted.
6. Restore connectivity → dead-lettered items re-drive successfully.
7. Retry backoff observed; retries stop on a terminal server response.
8. Readiness panel reports all three metrics.
9. Trigger latency unchanged.
10. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Headers/session. **Brief 42.** — Request bounds. **Brief 43.**
