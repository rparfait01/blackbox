# BRIEF 31 — ROOT-CAUSE FIX: TEST QUOTA MUST NOT TOUCH THE ALERT PATH

**No patches. No second-channel workaround. Find the structural fault and fix it so the system functions as
designed and specced. The delivery path is a core safety guarantee and it is currently coupled to the test suite —
that is the break. Fix the coupling.**

---

## THE STRUCTURAL FAULT (root cause, stated plainly)

The acceptance suite and the live alert path **share one SendGrid free-tier quota.** Running the tests exhausts
the quota the real alert path depends on. **Testing the safety system disables the safety system.** This has
surfaced repeatedly (the 05:21 failure, check 8's "flake," today's outage) because it is not a bug — it is a
design fault in how delivery is provisioned.

This is the thing to fix. Not the symptom (drained quota), not a workaround (add a channel) — the coupling
itself.

## THE FIX — separate the test delivery path from the production delivery path, structurally

- `[A]` The acceptance suite must **never consume production delivery quota.** Choose the right mechanism and
  state which and why:
  - **Dry-run / sandbox delivery in the suite** — the dispatcher records that it *would* send (channel, recipient,
    payload shape) and asserts on that, without hitting the real provider. This is the correct answer if the goal
    is to test dispatch logic, not the vendor.
  - **OR a dedicated test provider key** — a separate SendGrid/Twilio credential the suite uses, isolated from
    prod secrets, so production quota is untouchable by tests.
- `[A]` Whichever is chosen, it must be **impossible for an acceptance run to reduce the quota available to a real
  alert.** Prove it: run the full suite, show production quota unchanged.
- `[A]` The production alert path is unchanged by this — same real delivery for a real trigger. Only the test
  path is severed from prod resources.

## CHECK 8 — the delivery assertion was reporting a real outage as test noise

`delivered >= 1` in the acceptance suite was asserting real end-to-end vendor delivery, which is why a real
outage read as a "flake."

- `[A]` In the suite, assert on **dispatch** (the system attempted the correct channel with the correct payload),
  not on **vendor delivery** (a real email landed). Dispatch is what the system controls and what the test should
  verify. Real-vendor-delivery is a monitoring concern, not a unit of the acceptance gate.
- `[A]` If any check must verify true vendor delivery, it runs against the **test provider / sandbox**, never
  prod quota.

## VERIFY THE DELIVERY PATH ITSELF IS CORRECT (since we're here, prove the design works)

The multi-channel dispatcher was specced as: one dispatcher, channel as parameter, **preferred-with-fallback**
(try the preferred channel, fall back to another before reporting failure), honest status (never claim delivery
that didn't happen).

- `[L]` Prove **fallback actually fires**: preferred channel fails → dispatcher attempts the next channel before
  reporting failure. Test it against the sandbox with a forced primary failure. This is the design; confirm it
  works, because if fallback were working, a single-channel email failure would not have silently ended the
  chain.
- `[L]` Prove **honest status**: a genuine all-channels-failure reports "could not reach," never a false success,
  never silent.
- `[A]` Confirm the dispatcher is **not** hard-limited to one channel per contact in a way that defeats fallback.
  If a contact can carry SMS + LINE + email and the dispatcher only ever tries one, that is a design regression —
  name it and fix it.

## REGRESSION

- `[L]` Full acceptance suite runs to completion **without touching production quota** — prove it.
- `[L]` A real trigger still delivers by the real path (verify once, against the real provider, deliberately —
  not via the suite).
- `[L]` Hidden facade byte-identical; trigger/capture/closure/cascade untouched.

## REPORT

- The mechanism chosen (dry-run vs test key) and why.
- Proof the suite no longer consumes prod quota — full run, quota before/after unchanged.
- Check 8 converted to a dispatch assertion; any true-delivery check moved to sandbox.
- Fallback proven firing against a forced primary failure.
- Whether the dispatcher had a single-channel limitation defeating fallback — and if so, the fix.
- Deployed hash, both halves currency-asserted.

## DONE
The acceptance suite is structurally severed from production delivery quota — testing the safety system can no
longer disable it. Check 8 asserts dispatch, not vendor delivery. The preferred-with-fallback dispatcher is proven
to actually fall back, and honest status holds. The delivery path functions as specced. Committed, pushed, both
halves currency-asserted.

**This unblocks the gate (Brief 30 §B/§C) — acceptance can now run green without burning the alert path.**
