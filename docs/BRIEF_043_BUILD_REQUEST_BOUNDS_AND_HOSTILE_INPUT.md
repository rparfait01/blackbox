# BRIEF 43 — REQUEST BOUNDS AND HOSTILE INPUT

> **CARRIED IN — each item has an owner and closes here or is named as belonging elsewhere.**
>
> **1. Brief 41 acceptance 2 — the timing oracle. Fix it here; record the correction on Brief 41
> §B.** Existent addresses cost +23ms consistently across the distribution (p50 71 vs 48, p90 88
> vs 65) because an existent address mints a token, inserts a row, and walks into the send path
> while an absent one returns early. Identical bodies and status codes do not close it. For this
> product an enrolment map is a map of who is reachable by inbox. **Equalise the work — not a
> sleep, not a random delay. A random delay makes the oracle noisier without removing it.**
> Re-measure and report the distribution.
>
> **2. Brief 33 Fix A acceptance 9 — `CF_ANALYTICS_TOKEN`.** Still unset; headroom reads
> `NOT MEASURED`. It is the only visibility into the free-tier daily cliff, and the account has
> already gone over once. Report exactly what is needed and whether it is a credential action
> Royce must take.
>
> **3. `master` is 157 commits behind HEAD.** Fast-forward it, or rename the working branch to
> trunk and update the deploy flag. It reads as trunk to whoever arrives later.
>
> **4. Ratified, add to `STANDING_CONSTRAINTS.md` verbatim:**
> "A control applies to an origin, not to a product. Where a system spans more than one origin,
> every control is enumerated per origin and the coverage is asserted. A header file that protects
> the static origin while the API origin serves the sensitive URL is a control applied to the
> place someone was looking rather than the place it mattered."
> *(Origin: `_headers` is a Cloudflare Pages file; the coordinator dashboard is served by the
> Worker, which had no security headers at all — so the one origin whose URL carries an
> event-bound magic token was the one with no referrer policy.)*
>
> **5. Ratified without change:** `no-referrer` on the Worker because the token is in the path and
> no middle setting is worth having; the wildcard mount applied after `next()` so a later route
> inherits it; **no CSP on the Worker** — the dashboard renders inline script, nonces would be
> required, and it sits on the alert path, so three headers that cannot break a render is the
> correct scope; `bbcoord` carrying the claim key rather than the magic token.
>
> **6. Honest limit, carried to its owner:** cookie attributes were verified by guard and source,
> not by observing a live `Set-Cookie`, because claiming a coordinator event needs a dispatched
> token and Brief 35 Fix B's suppression means staging cannot deliver one. **Brief 33 Fix B works
> that exact flow and observes it live** — added to its acceptance. Do not re-open it here.
>
> **7. Brief 42 is closed except acceptance 3, 4, 5, 6**, which ride on Brief 51 §A item 14.
> CSP enforcement stays held. This is now the baseline Brief 33 Fix B §E2 must not weaken.
>
> **8. Do not arm anything.** Brief 36 item 12 and Brief 2 Fix A §E3 are owned by Brief 51.
>
> **9. Queue after this brief:** Brief 23 Fix A (tenancy attribution — `orgId` stays nullable, no
> mandatory affiliation), then Brief 33 Fix B (coordinator token in the URL), then Brief 50
> (capture integrity and live relay). Brief 51 runs in parallel on Royce's phone.

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
