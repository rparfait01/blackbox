# BRIEF 30 FIX A — SIGNUP CAPABILITY: A HANDLE IS NOT A CREDENTIAL

**Type:** FIX A on Brief 30 (signup gate)
**Priority:** P1
**REQUIRES:** Brief 33 Fix A, Brief 35 Fix A, Brief 40 §B/§C — all green. The acceptance suite is
~12k requests; it needs headroom and a working gate.
**Ship order:** FOURTH — after Brief 33 Fix A, Brief 35 Fix A, Brief 40 §B/§C.
**Floor:** Briefs 35–40. Zero regression to signup, enrollment-code redemption (Brief 30 §C),
passkey registration, or account reset (Brief 32).
**Mode:** server-side. No device dependency.
**Audit ref:** Pass 1 Finding 8 · Pass 2 Finding 8 (Confirmed — P1)

---

## CORRECTIONS

**BRIEF 030 §C — corrected to read:**
"Signup state is carried by a signed, scoped, short-lived capability. An identifier returned by
an earlier step is a handle, never an authorization. Possession of a handle grants nothing."
Path: `workers/api/src/routes/signup.ts`

---

## THE DEFECT

`signupId` is accepted as proof of authorization for subsequent signup steps. It is a database
identifier: unsigned, non-expiring, unbound to the requester, and scoped to whatever the
accepting endpoint will do. Anyone who obtains one — from a log, a shared link, a referrer, a
support screenshot — continues that signup.

The enrollment gate is only as strong as the token carrying its result.

---

## §A — SIGNED CAPABILITY

- Replace bare `signupId` with a signed token: issuer, subject, **explicit scope**, issued-at,
  short expiry, single-use where the step is not idempotent.
- Scope names the exact steps authorized. A step-2 capability does not authorize step 4.
- Verified server-side on every use. Invalid, expired, or out-of-scope fails with a plain honest
  message — never a silent 200, never a generic error (Brief 30 §C wording rule).

## §B — BINDING

- Bind to something the requester holds, not to a value that travels: the redeemed enrollment
  code, or a client-generated nonce committed at step 1.
- Replay of a consumed single-use capability is rejected and audited.

## §C — EXPOSURE

- Never in URLs, query strings, referrers, or logs. Request bodies or headers only.
- Audit rows record the capability's identifier and scope, never the token.

## §D — LOCKOUT IS WORSE THAN EXPIRY

A broken gate blocks account creation, including a survivor in danger.

- Expiry long enough for a real person on a slow connection to finish onboarding. State the
  lifetime and the reasoning.
- An expired capability offers an immediate self-service restart. Never a dead end, never a
  support ticket.

## §E — ANTICIPATED GAPS

1. **Clock skew.** A device with a wrong clock must not be locked out of signup. Validate against
   server time only; never trust a client timestamp for expiry.
2. **Partial signup.** A capability expiring mid-flow must not leave an orphaned half-account
   that blocks the same enrollment code from being redeemed again. Redemption and account
   creation stay atomic (Brief 30 §C); an abandoned flow releases the code.
3. **Key rotation.** The signing key for capabilities will eventually rotate. In-flight
   capabilities signed by the previous key must remain valid until expiry — same rotation
   discipline as Brief 39 §C. Do not build a scheme where rotation locks out everyone mid-signup.

---

## ACCEPTANCE

1. Full signup completes end to end. Screenshot the created account.
2. Replay a consumed single-use capability → rejected, audited.
3. Step-2 capability at step 4 → rejected on scope.
4. Expired capability → rejected, working self-service restart.
5. Forged/tampered token → rejected on signature.
6. Grep logs, access logs, audit rows for token material → zero hits.
7. Skewed device clock → signup still completes.
8. Abandon a flow mid-way → the enrollment code is redeemable again; no orphaned account.
9. Rotate the capability signing key → in-flight capabilities still valid until expiry.
10. Enrollment-code redemption and account creation remain atomic.
11. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Event authority. **Brief 2 Fix A.** — Rate limiting. **Brief 41.**
