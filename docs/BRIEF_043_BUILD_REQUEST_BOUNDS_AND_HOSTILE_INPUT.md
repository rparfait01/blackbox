# BRIEF 43 — REQUEST BOUNDS AND HOSTILE INPUT

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

1. Each route rejects oversized bodies at the stated bound with a stable error, **without
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
