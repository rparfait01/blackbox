# BRIEF 43 — REQUEST BOUNDS AND HOSTILE INPUT

> **CARRIED IN — do these as part of this brief. No item below is a loose note; each has an owner
> and closes here or is named as belonging elsewhere.**
>
> **1. Brief 41 acceptance 2 — the timing oracle. Fix it here, record the correction on Brief 41
> §B.** Existent addresses cost +23ms consistently across the distribution (p50 71 vs 48, p90 88
> vs 65) because an existent address mints a token, inserts a row, and walks into the send path
> while an absent one returns early. Identical bodies and status codes do not close it. For this
> product an enrolment map is a map of who is reachable by inbox. **Equalise the work — not a
> sleep, not a random delay. A random delay makes the oracle noisier without removing it.**
> Re-measure the distribution and report it.
>
> **2. Brief 33 Fix A acceptance 9 — `CF_ANALYTICS_TOKEN`.** Still unset; headroom reads
> `NOT MEASURED`. It is the only visibility into the free-tier daily cliff, and the account has
> already gone over once. Report exactly what is needed to set it and whether it is a credential
> action Royce must take.
>
> **3. Repository housekeeping — `master` is 157 commits behind HEAD.** Fast-forward it, or rename
> the working branch to trunk and update the deploy flag. It reads as trunk to anyone who arrives
> later, including Royce in six months.
>
> **4. Not this brief, and now owned:** every deferred device-dependent acceptance item and both
> arming gates are **Brief 51 (VERIFY — device session and arming)**. Thirteen rows across Briefs
> 35, 36, 38, and 2 Fix A. Do not treat any of them as this brief's business, and do not arm
> anything.
>
> **5. Queue after this brief:** Brief 23 Fix A (tenancy — decision outstanding on §F1, how an
> unaffiliated Gumroad consumer is represented), then Brief 50 (capture integrity and live relay).
> Brief 51 runs in parallel; it needs Royce's phone, not CC's context.

**Type:** BUILD — no prior brief shipped bounds or schema validation
**Priority:** P2
**REQUIRES:** Brief 39 green (§C sweeps the verifier it hardened); Brief 36 Fix A green (§A degrades
per its contract where a bound would drop evidence); Briefs 41 and 42 green.
**Ship order:** NINTH. **Closes the audit remediation set.**
**Floor:** Briefs 35–42. Zero regression across the full suite.
**Audit ref:** Pass 1 Finding 13 · Pass 2 Finding 13 (Confirmed — P2), plus the `fingerprintSpki`
class surfaced during Brief 39.

---

## THE DEFECT

Request bodies are accepted without size or shape bounds. Classification and transcript arrays are
consumed unvalidated and can throw on malformed input. Brief 39 surfaced the same class on the
verifier: `fingerprintSpki` threw on a malformed key, so a hostile export could crash the
verification tool — **denial of verification, which needs no forgery to be useful to an
adversary's counsel.**

---

## §A — BOUNDS

- Stated maximum body size per route. Name the numbers.
- Stated maximum array length, string length, nesting depth. Reject beyond; never truncate
  silently.
- **Capture-path routes are bounded but never rejected for being large** — an unusually long event
  is a real event. Where a bound would drop evidence, degrade per Brief 36 §D instead.

## §B — SCHEMA VALIDATION

- Every route validates its body against an explicit schema before use.
- Failure returns a stable, non-leaking error and an audit row.
- No route reaches business logic on unvalidated input.

## §C — HOSTILE INPUT NEVER THROWS

Class rule, from Brief 39:

- Any code parsing untrusted input — request bodies, exports, keys, tokens, uploaded packages —
  treats every field as hostile and **never throws**. It returns a value that fails closed.
- Sweep the verifier and every parser on the request path. `fingerprintSpki` was one instance;
  find the rest.
- Fuzz cases in the suite: truncated, oversized, wrong-type, deeply nested, malformed base64,
  malformed keys.

## §D — TEST FIXTURE SWEEP

From Brief 39's `signingFixture()` defect: audit the suite for fixtures that regenerate the value
they are supposed to assert against. **A test that cannot fail is worse than no test** — it
reports confidence it has not earned.

## §E — ANTICIPATED GAPS

1. **Rejection must be cheap.** Bounds checks that read the full body before rejecting spend the
   cost they exist to prevent. Check `Content-Length` and stream limits before buffering.
2. **The verifier is offline.** Its hardening cannot rely on server-side validation. It is a
   standalone artifact a hostile party will feed hostile input directly.
3. **Bounds versus long captures.** A four-hour event is legitimate. Prove a long real capture is
   not rejected before shipping any capture-path bound.

---

## ACCEPTANCE

1. **Carried-in item 1:** timing oracle closed by equalised work. Re-measured distribution
   reported for existent vs non-existent identifiers, showing no usable difference. Correction
   recorded on Brief 41 §B.
2. **Carried-in items 2 and 3:** analytics token status reported; `master` reconciled.
3. Each route rejects oversized bodies at the stated bound with a stable error, **without
   buffering the body.**
2. Malformed classification and transcript arrays rejected, never thrown on.
3. Fuzz corpus clean against every untrusted-input parser — zero uncaught throws.
4. Hostile export against the verifier → fails closed with a named outcome, never a crash.
5. A long legitimate capture is not rejected; degradation path used where a bound would bite.
6. Fixture sweep complete; any self-asserting fixture fixed and listed in the report.
7. Trigger, capture, closure, cascade unaffected.
8. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

Nothing. **This brief closes the audit remediation set.**

All 12 second-pass findings remediated. Remaining outside it: Brief 36 acceptance item 12 (arming
`REQUIRED`), the consolidated device session, Brief 23 Fix A (tenancy), Brief 0B (closure scales),
and the double-tap gesture items.
