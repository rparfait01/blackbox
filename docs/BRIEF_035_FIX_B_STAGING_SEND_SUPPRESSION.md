# BRIEF 35 FIX B — STAGING CANNOT REACH A REAL PERSON

**Type:** FIX B on Brief 35 (§D built dispatch suppression by identity; this extends it by
environment)
**Priority:** P1 — standing safety gap, independent of any acceptance item
**REQUIRES:** Brief 35 Fix A green. Brief 41 green.
**Ship order:** BEFORE Brief 41 acceptance 3 and before Brief 42.
**Floor:** Briefs 35–41. **Zero regression to production dispatch.**
**Mode:** fresh session. This is a change to the alert path and gets full context.

---

> **THE CONTEXT, SO THIS IS NOT RE-DERIVED**
>
> Staging holds a live `SENDGRID_API_KEY` — confirmed via canary status. Whether it draws on a
> separate SendGrid account from production is unknown and was not going to be established
> empirically, because **this project has already had a real 05:21 alert reach nobody after test
> sends drained the credits.**
>
> That makes this a standing safety gap, not scaffolding for a test. Two failure modes exist
> today: a staging send reaching a real inbox, and staging sends consuming the credits a
> production cascade depends on. Both are live right now.
>
> Brief 41 acceptance 3 — drain the unauthenticated cap, then confirm a real trigger's cascade
> still delivers from the reserved allocation — is blocked on this and unblocks the moment it
> ships. It is the last guarantee in Brief 41 still resting on construction, and this project's
> record is that construction-only properties fail on their first live run: the capability key
> rotation, `expectedPublicKey`, `PURGED_BY_CONSENT`.

---

## CORRECTIONS

**BRIEF 035 §D — corrected to read:**
"Dispatch suppression has two independent axes. **By identity:** the event's `isTest` flag and
the owning account's `isCanary` flag, both re-derived server-side at dispatch time, either alone
dispatching normally and raising an operator alert. **By environment:** a non-production
environment never reaches an external provider at all. The two are separate controls and neither
substitutes for the other."
Path: `workers/api/src/lib/notify.ts`

---

## §A — ENVIRONMENT-BOUND SUPPRESSION

- Every outbound send — SendGrid, Twilio, LINE, push — is gated on a server-derived environment
  identity. Non-production never calls an external provider.
- **Derived, never configured.** The environment comes from the Worker's own binding set, the
  same way the R2 authority rule works. Not from an environment variable a deploy could omit,
  not from a hostname string, not from a client value.
- The gate is an **allow-list**: production is the only environment permitted to dispatch
  externally. A new environment added later is suppressed because it was never added — the Brief
  41 `ruleFor()` pattern.
- A suppressed send records a delivery row with a distinct status (`suppressed_environment`,
  separate from `suppressed_test`) and the full payload it *would* have sent, so staging
  acceptance can assert on content without transmitting it.

## §B — FAIL TOWARD DISPATCH IN PRODUCTION

The failure mode that matters is not a leaked staging email. It is production silently
classifying itself as non-production and suppressing a real cascade.

- If the environment cannot be determined, **dispatch proceeds** and an operator alert fires.
  Refuse-everyone on the alert path is a survivor who cannot call for help.
- A production deploy asserts at startup that it resolves to production and that external
  dispatch is enabled. Failure to resolve is a deploy failure, not a runtime surprise.
- The Brief 35 gate verifies this alongside the origin and lock checks: **production must prove
  it can dispatch.**
- Per the standing rule, this comparison is proven both ways before ship — a case that dispatches
  and a case that suppresses.

## §C — CREDENTIAL SEPARATION

- Staging's provider credentials are removed or replaced with values that cannot authenticate.
  §A prevents the call; §C ensures a bug in §A cannot succeed. Two independent barriers.
- If a staging credential must exist for shape-testing, it is a distinct key on a distinct
  account with its own quota. **Never the production key.**
- The readiness panel reports, per environment, whether external dispatch is enabled and whether
  a provider credential is present. A staging row showing both is an alertable condition.

## §D — THE OPERATOR ALERT CHANNEL DOES NOT EXIST

Named here because Brief 41 acceptance 7 cannot be proven without it, and because every brief
from 33 onward has specified error-level alerts with no defined destination.

Alerts currently fire into logs nobody watches. **An alert nobody receives is not an alert** —
same class as a verdict with no code path that produces it.

- Define one destination. Simplest sufficient answer: a dedicated email address, delivered
  through the production provider, treated as an alert-path send so §A never suppresses it in
  production.
- The destination is stated in code and on the readiness panel.
- **Alerts are rate-limited but never dropped.** A storm collapses to a count plus the first and
  last instance. Silence must mean nothing happened.
- Retrofit every existing error-level alert to that destination: `canary_flag_on_non_canary_account`,
  `routable_contact_on_canary_account`, seal-pending threshold, vault backlog, sustained limiting,
  `UNAVAILABLE`/`QUOTA_EXCEEDED` gate outcomes, storage degradation, headroom 80%.
- Report the retrofit as a list. An alert not on it is an alert that still goes nowhere.

## §E — ANTICIPATED GAPS

1. **The canary must still work.** It runs in production and asserts `suppressed_test`. §A must
   not suppress it by environment before §D's identity suppression is reached, and the two
   statuses must remain distinguishable in the delivery rows.
2. **Ordering.** Environment suppression is evaluated before identity suppression, so a staging
   canary records `suppressed_environment`. Both are correct; the acceptance must know which to
   expect where.
3. **The alert channel is itself a send.** If §D's destination is suppressed by §A in a
   non-production environment, staging alerts vanish silently. Accept that deliberately and state
   it, or route non-production alerts to the delivery-row record only.
4. **Do not build a bypass.** No flag, header, or argument re-enables external dispatch in a
   non-production environment. If shape-testing a real provider is ever needed, that is a
   production canary account, not a staging bypass.

---

## ACCEPTANCE

1. Staging send attempt → zero external provider calls. Confirm at the provider dashboard, not
   only in the delivery rows.
2. Delivery row records `suppressed_environment` with the full payload that would have been sent.
3. Production dispatch unaffected: real trigger, full cascade, contacts actually receive.
   **Screenshot a real delivery.**
4. Force the environment to be indeterminate → **dispatch proceeds**, operator alert fires.
5. Production deploy asserts it resolves to production with dispatch enabled. Break it → deploy
   **fails**.
6. Production canary still records `suppressed_test`, distinguishable from
   `suppressed_environment`.
7. §C: staging provider credentials removed or separated; readiness panel reports per-environment
   dispatch state and credential presence.
8. §D: alert channel defined and live. Fire one alert of each retrofitted type and confirm each
   **arrives**. Report the full retrofit list.
9. Alert storm → collapses to count plus first and last, none dropped.
10. **Brief 41 acceptance 3, now unblocked:** on staging, lift the rate-limit exemption for one
    non-reserved identifier, drain the unauthenticated outbound cap, fire a real trigger, confirm
    the cascade completes in full from the reserved allocation. Restore the exemption and confirm
    it is restored.
11. **Brief 41 acceptance 6:** limiter store unavailable → fails open, alerts, login still works.
12. **Brief 41 acceptance 7:** sustained limiting on one identifier → alert fires and **arrives**
    at §D's destination.
13. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- **Brief 41 acceptance 2 — the timing oracle is a live finding, unfixed.** Existent addresses
  cost +23ms consistently across the distribution (p50 71 vs 48, p90 88 vs 65) because an
  existent address mints a token, inserts a row, and walks into the send path while an absent one
  returns early. Identical bodies and status codes do not close it. For this product an
  enrolment map is a map of who is reachable by inbox — the exact threat email reset was banned
  over. **Fix by equalising the work, in Brief 41 §B. Not a sleep, not a random delay — a random
  delay makes the oracle noisier without removing it.** Owner: Brief 41 §B, next session.
- Facade-diff harness. **Brief 42 §A**, and its first task rather than an afterthought — the same
  shape as the latency harness that made Brief 2 Fix A §0 checkable.
- Brief 2 Fix A acceptance 2, 7, 8, 11 — device session.
- `CF_ANALYTICS_TOKEN` unset; headroom reads `NOT MEASURED`.
- `master` 157 commits behind HEAD.
- **Nothing is armed.** Brief 36 item 12 and Brief 2 Fix A §E3 both wait on the device session.
