# BRIEF 41 — ABUSE CONTROLS: COST THE ATTACKER, NEVER THE SURVIVOR

**Type:** BUILD — no prior brief shipped abuse controls
**Priority:** P1
**REQUIRES:** Brief 30 Fix A and Brief 2 Fix A green — the limiter keys on capabilities and device
credentials, not on `signupId` and `userHash`. Brief 33 Fix A green.
**Ship order:** SIXTH.
**Floor:** Briefs 35–40, Brief 30 Fix A, Brief 2 Fix A. Zero regression to trigger, capture,
closure, cascade, signup.
**Audit ref:** Pass 1 Finding 9 · Pass 2 Finding 9 (Confirmed — P1)

---

## §0 — THE RULE THAT GOVERNS THIS BRIEF

**No control here may ever apply to the trigger path, the capture path, the cascade, or
closure.** A rate limit that delays an alert is a worse defect than the abuse it prevents.
Controls apply to authentication, enrolment, lookup, and console surfaces only.

The exempt-path list is stated explicitly in code and **proven** in acceptance, not asserted.

---

## THE DEFECT

Shared authentication and lookup endpoints have no abuse controls: no per-identifier or
per-origin limiting, no lockout, no enumeration resistance. Consequences — credential and
identifier enumeration, enrolment-code brute force, and exhaustion of the SendGrid/Twilio quota
the alert path depends on. Brief 31 decoupled the test suite from that quota; an unauthenticated
attacker can still drain it.

---

## §A — LIMITS

- Per-identifier and per-origin on: login, magic-link request, passkey challenge, enrolment-code
  redemption, signup steps, recovery-code use, console login.
- **Progressive backoff, not hard lockout.** A survivor locked out of her own account is a safety
  failure.
- Limits are stated constants, not magic numbers.

## §B — ENUMERATION RESISTANCE

- Identical responses and indistinguishable timing for existent and non-existent identifiers.
- Enrolment-code failures stay honest about *what* is wrong (Brief 30 §C) without confirming a
  different code would exist.

## §C — PROTECT THE OUTBOUND QUOTA

- Cap unauthenticated outbound sends per identifier and per window.
- **The alert path draws on a reserved allocation abuse traffic cannot reach.** Brief 31 fixed the
  test-suite coupling; this closes the attacker coupling.
- Quota headroom on the readiness panel, alongside Brief 33 Fix A §F request headroom.

## §D — OBSERVABILITY

- Limit events audited with identifier, origin, rule.
- Sustained limiting on one identifier alerts at error level — that is a targeted attack on a
  specific survivor, not background noise.

## §E — ANTICIPATED GAPS

1. **Shared egress.** A DV shelter puts many survivors behind one NAT. Per-origin limiting would
   throttle a whole shelter. Per-identifier is primary; per-origin ceilings are generous and
   never applied to an authenticated session.
2. **The coordinator is not the attacker.** `/v1/c/*` is capability-scoped and sits on the alert
   path. It is exempt under §0.
3. **Limit state must not become a new outage.** If the limiter's own store is unavailable, it
   **fails open** and alerts. A limiter that fails closed takes down login for everyone.
4. **Cloudflare request cost.** Limiting consumes requests to reject requests. Reject as early as
   possible in the Worker, before any D1 read.

---

## ACCEPTANCE

1. Each limited endpoint refuses under sustained load; backoff is progressive.
2. Existent vs non-existent identifier: responses and timings indistinguishable. Show the
   distribution.
3. **Drain the unauthenticated outbound cap, then fire a real trigger → cascade delivers in full.
   Screenshot the delivery.** This is the item that matters.
4. Trigger, capture, closure, cascade under active limiting → unaffected. Exempt-path list
   proven, not asserted.
5. Many identifiers behind one origin → not collectively throttled.
6. Limiter store unavailable → fails open, alerts.
7. Sustained limiting on one identifier → error-level alert.
8. Survivor retrying a mistyped code → not locked out.
9. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Headers and session rotation. **Brief 42.** — Request bounds. **Brief 43.**
