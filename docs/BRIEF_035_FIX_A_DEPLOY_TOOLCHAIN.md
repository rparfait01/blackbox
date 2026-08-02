# BRIEF 35 FIX A — DEPLOY TOOLCHAIN: A GATE A HUMAN CAN FINISH IS NOT A GATE

**Type:** FIX A on Brief 35 (deploy gate)
**Priority:** P1 — prerequisite for Brief 40 §B/§C
**REQUIRES:** Brief 33 Fix A green and deployed. §F's headroom check and the gate's own request
cost both assume the polling loops have stopped. Building this first will fail.
**Ship order:** SECOND, after Brief 33 Fix A.
**Floor:** Briefs 35–40 §F, Brief 33 Fix A. Zero regression to the gate, the Brief 36 §F canary,
or any deploy behaviour.
**Mode:** proven by deliberately breaking it.
**Status:** §B–§F shipped at `0e56bb4`, live in production at `e72f207`. Acceptance 2–10 and 12
green. **§A is the only open section** and is the last blocker on Brief 40 §B/§C.

---

## CORRECTIONS

*Added post-ship, from §B–§F acceptance.*

**BRIEF 035 FIX A §B — corrected to read:**
"`isOurBuild` invokes git without a shell. On Windows `cmd.exe` treats `^` as an escape
character, so `git cat-file -e <sha>^{commit}` run through a shell returns false for every build
id — classifying ordinary propagation delay as `WRONG_ARTIFACT`, terminal, zero retries. That is
the exact inverse of this section's purpose and is invisible on any deploy that reaches
`CURRENT` on the first attempt."
Path: `scripts/assert-currency.mjs`

**BRIEF 035 FIX A §C — corrected to read:**
"The gate's run marker is single-use and is spent even by a wrong guess. A length check is not a
nonce. The habit being prevented is not forgery — it is a stumbled gate re-run against a still-
exported environment."
Path: `scripts/canary.mjs`

**BRIEF 035 FIX A §F — corrected to read:**
"The request-cost line is read from the spawned child's reported count, not from an in-memory
counter in the parent. A cost line reporting `0` beneath a table showing successful polls is a
number an operator believes."
Path: `scripts/deploy.mjs`

**BRIEF 035 §C — corrected to read:**
"The deploy gate terminates in exactly two states: passed or failed. No operator completes,
resumes, or supplements it by hand. A gate a human can finish is not a gate."
Path: `scripts/deploy-pages.mjs`, `scripts/deploy.mjs`

**BRIEF 021 §1 — corrected to read:**
"The currency poll distinguishes not-yet-propagated from infrastructure-unavailable from
quota-exceeded from wrong-artifact. Only the last is a stale-build failure; each of the others
calls for a different operator response and is reported by name."
Path: `scripts/deploy-pages.mjs`

---

## THE DEFECT

The currency poll abandoned a **correct** deploy twice, and on both occasions the gate was
completed by running the canary by hand.

1. **It cannot classify failure.** A 521/522 from an over-quota account consumed the same budget
   as a genuinely stale artifact. The account was over the free-tier daily cap; the poll reported
   it as a propagation timeout.
2. **A manual completion path exists and has been used twice.** That becomes habit, and the
   gate's guarantee is gone. Same class as `expectedPublicKey` being optional and
   `ENVELOPE_ENCRYPTION_ENABLED` reading armed while encrypting nothing: a control that reports
   as enforcing while not enforcing.

---

## §A — WRANGLER 3.114.17 → 4.x `[OPEN — SHIP NEXT]`

- **Own commit. Nothing else in it.** Do not begin a toolchain upgrade in the same turn as any
  other change.
- The bucket-lock endpoint returns 521 on 3.x. Confirm it responds on 4.x — that is the entire
  reason for this upgrade and the only hard blocker on Brief 40 §C.
- **Re-prove on the new toolchain before anything else moves.** This list is acceptance item 1:
  - **Brief 35 gate:** build refusal on missing / empty / `http://` / private-range origin;
    bundle-byte grep; canary round trip; `suppressed_test` delivery rows; purge confirmation.
  - **Brief 36 §F:** canary traverses the real encryption path; canary key failure fails the
    deploy.
  - **Brief 40 §A/§F:** cursor pass and seal drain unaffected; bounded cron still inside 20s per
    job.
  - **Brief 33 Fix A:** polling bounds and socket backoff unaffected by any bundling change.
  - Full suite 90/90.
- Report the gate's request cost on the new toolchain. It was 24 on 3.x; a change is a finding.
- **Anticipated gaps:**
  1. Wrangler 4 changes `wrangler.toml` handling and some flags. Any config migration is part of
     this commit and is stated in the report — never left implicit.
  2. `--remote` behaviour changed between majors. Confirm no script silently reads local
     miniflare state; the Worker's own binding is the only authority for R2 state.
  3. If the upgrade changes deploy output parsing, the currency poll's classification depends on
     it. Re-prove §B's five outcomes against the stub harness, not against reasoning.

## §B — FOUR OUTCOMES

| Observation | Classification | Effect |
|---|---|---|
| Version matches expected | `CURRENT` | Passes |
| Version present, older | `PROPAGATING` | Consumes budget |
| 5xx / 52x / connection failure | `UNAVAILABLE` | **Pauses budget**, backoff |
| 429 / quota signal / account over plan limit | `QUOTA_EXCEEDED` | **Immediate failure by name** |
| Version present, unrelated | `WRONG_ARTIFACT` | **Immediate failure**, no retry |

- `QUOTA_EXCEEDED` never retries. Retrying an over-quota account adds load to the condition it is
  waiting on — the same self-sustaining shape as Brief 33 Fix A §C.
- Budget is stated wall-clock, sized for real propagation. Name the number and the reasoning.
- `UNAVAILABLE` has its own longer ceiling; exceeding it fails as `INFRASTRUCTURE_UNAVAILABLE`.
- Exponential backoff with jitter throughout. No fixed-interval hammering of a recovering colo.

## §C — REMOVE THE MANUAL PATH

- Delete every operator-invocable route that completes, resumes, or substitutes for the gate.
- The canary is invocable only inside a gated deploy. No standalone entry point.
- A diagnostic invocation, if genuinely needed, writes a distinguishable audit marker and
  **cannot** satisfy the gate. A diagnostically-satisfied deploy is visibly identifiable as not
  passed.
- Guard test: no code path marks the gate satisfied except the poll.

## §D — RECOVERY IS RESUMPTION, NOT BYPASS

- Failure messages name the re-run command. Re-running is cheap and idempotent — publish is
  already done; the gate re-verifies.
- No flag, environment variable, or argument skips or shortens the gate. If one exists, delete it.

## §E — RECORD AND ALERT

- Every gate outcome recorded with classification, elapsed time, attempt count.
- Two consecutive `UNAVAILABLE` or any `QUOTA_EXCEEDED` alerts at error level.

## §F — ANTICIPATED GAP: THE GATE'S OWN COST

The gate spends requests to verify a deploy. Under quota pressure that is self-defeating.

- Report the gate's request cost per run. Name the number.
- Cap the poll's total attempts, not only its wall-clock budget.
- If headroom (Brief 33 Fix A §F) is below a stated threshold, the deploy **refuses to start**
  and says so. Do not discover mid-deploy that there was no budget for it.

---

## ACCEPTANCE

1. Wrangler 4.x; §A re-proof list green, 90/90.
2. Normal deploy passes unattended, start to finish.
3. Stale colo → `PROPAGATING` → resolves → passes.
4. 522 → `UNAVAILABLE`, budget pauses, backoff in the log, passes on recovery. **This is the
   scenario that abandoned two correct deploys — prove it directly.**
5. Sustained 522 past ceiling → `INFRASTRUCTURE_UNAVAILABLE`, names the re-run command.
6. Simulated quota signal → `QUOTA_EXCEEDED`, **zero retries**, names billing.
7. Wrong artifact → `WRONG_ARTIFACT`, immediate, no retry.
8. **Grep for any manual gate-completion path → zero results.** Guard test asserts it.
9. Attempt to satisfy the gate by any other means → impossible. Show the attempt.
10. Headroom below threshold → deploy refuses to start.
11. Gate request cost reported.
12. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Brief 40 §B/§C. This is their prerequisite; run them immediately after.
