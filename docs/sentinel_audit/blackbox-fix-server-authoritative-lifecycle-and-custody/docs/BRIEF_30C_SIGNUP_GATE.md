# BRIEF 30 §C — SIGNUP GATE (close the open front door)

**The model is locked (§B, enrollment_codes unified + live). The atomic primitive is shared and tested. Build the
gate. Get it right — a broken gate locks out account creation, including a survivor in danger.**

---

## THE GATE

- Signup requires a valid, unredeemed code. No code / already-redeemed / expired / revoked → **fail with a plain
  honest message that says what's wrong** — never a silent 200, never a generic error.
- `[A]` Redemption + account creation are **atomic** — use the existing shared conditional-UPDATE primitive from
  §B. Never read-then-write.
- `[A]` **Prove atomicity with a concurrent-request test** — two requests racing the last use, only one wins.
  Not a single-request pass.
- `[A]` On a failed signup after a code was consumed, `releaseOneUse` returns it (§B already built this) — a
  buyer's paid code is never burned by a failed signup.

## CONSUMER PATH — Gumroad webhook

- `POST /webhooks/gumroad/sale`, verified with `ACTIVATION_WEBHOOK_SECRET` (in prod).
- `[A]` Signature verification **fail-closed** — bad or absent signature → reject, never issue a code. Copy the
  HMAC pattern from `activation.ts`.
- On verified sale: generate a code via the existing `createEnrollmentCode` (source=`consumer`, org_id null),
  deliver to buyer (SendGrid email and/or success page with the code pre-filled into onboarding).
- `[A]` Reserved-address suppression (Brief 31) still applies — a test sale never burns real quota.
- Gumroad Ping URL (Settings → Advanced) points here.

## INSTITUTIONAL PATH — admin issuance

- Already exists via `POST /v1/admin/orgs` and the code endpoints. Confirm the admin can issue
  source=`institutional` codes (org_id set) through the existing path.
- `[A]` **Completely separate from the consumer flow.** No Gumroad, no payment, ever. This is the DV-shelter path.

## ENTITLEMENT WIRING — no signed-up-but-unarmable state

- `[A]` Code redemption grants Brief 28 entitlement: consumer → `purchase_web`, institutional → `org_code`.
  A redeemed code means the account can **arm**, not just exist. Wire redemption → `grantEntitlement`.

## GRANDFATHER — do not lock out the surviving account

- `[A]` `developer@blackboxsentinel.com` predates the gate. The gate applies to **NEW signups only.** Confirm the
  survivor still signs in and arms post-deploy.

## TRIGGER UNTOUCHED

- `[A]` No signup-gate or entitlement check anywhere in trigger / capture / dispatch. Grep-prove. The button
  always fires.

## MIGRATION + DEPLOY

- Any migration goes to prod first, then deploy. Both halves currency-asserted.

## REGRESSION

- `[L]` Re-run signup acceptance — updated for the required code param; CORS, field validation, no silent
  failures still hold.
- `[L]` Hidden facade byte-identical; trigger/capture/closure/cascade untouched.
- `[L]` Full suite green **without touching prod delivery quota** (Brief 31 severance holds).

## REPORT

- Endpoints added; schema diff if any.
- **Concurrent-request proof of atomic redemption.**
- Gumroad webhook fail-closed proof (bad sig → no code).
- Confirmation redemption grants entitlement (buy → code → signup → armed, one path).
- Confirmation `developer@` still signs in and arms.
- Deployed hash, both halves currency-asserted.

## DONE
Signup is gated on atomic code redemption. Consumer codes come from a fail-closed Gumroad webhook; institutional
codes from the separate admin path. Redemption grants entitlement so there's no signed-up-but-unarmable state. The
surviving account is grandfathered, the trigger is untouched, and the suite runs green without burning the alert
path. Committed, pushed, deployed.

**Front door closed. Next: the three-role dashboard + operator maintenance panel.**
