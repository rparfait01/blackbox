# BRIEF 30 — SIGNUP GATE + DEPLOY THE CASCADE-AUDIT FIX

**Gumroad is selling live with ZERO signup gate. Close this before more sales. Runs before the dashboard.**
**Order is fixed: §A → §B → §C. Do not reorder.**

---

## §A — DEPLOY THE PENDING via FIX FIRST (unblocks the pre-push gate)

The uncommitted `via` cascade-audit change is test-infra, not dormant ZK. Ship it clean so the pre-push gate
stops burning SendGrid quota on every push.

- `[A]` **Before committing, report what deploys:** is it the `via` changes ONLY, or does dormant Brief 29 /
  verifier / `.well-known` key-route code ride along? State it plainly — I want to know, not discover it.
- Commit clean (no dirty tree — fixes yesterday's stale provenance stamp).
- Deploy. Both halves currency-asserted (Brief 0 hardening must pass).
- Run acceptance ONCE. Check 8 (`via==='alarm'`) and check 9 now verifiable against a worker that writes `via`.
- `[A]` Report the deployed hash; confirm Pages == Worker == that hash.

**Do not proceed to §B until acceptance is green on the deployed worker.**

---

## §B — RECONCILE THE CODE TABLES (do NOT create a second code system)

**STOP before creating `access_codes`.** Briefs 23/24/28 already shipped `enrollment_codes` + a shared Crockford
code generator + redemption with rate-limiting.

- `[A]` **Report first:** what does `enrollment_codes` already do, and can it carry a consumer/institutional
  source with a nullable `org_id`? 
- **Strongly preferred: extend `enrollment_codes`, do not add `access_codes`.** Two code tables that mean the same
  thing will force the dashboard to manage both and is a guaranteed drift bug.
- Reuse the existing generator and the existing atomic-redemption path. Do not write a second one.
- If — and only if — `enrollment_codes` genuinely cannot represent the consumer path, say why in one line before
  adding anything. Otherwise extend it with:
  - `source` (`consumer` | `institutional`) — default institutional (existing rows grandfather cleanly)
  - `org_id` already exists (nullable) — consumer codes leave it null
  - status/redemption columns already exist — reuse, don't duplicate

## §C — GATE SIGNUP ON CODE REDEMPTION

Signup currently has no gate (Brief 14 removed friction for the 2-person pilot). Close it.

**The gate:**
- Signup requires a valid, unredeemed code. No code / already-redeemed → **fail with a plain honest message**
  (not silent 200, not generic error — say what's wrong). Same honest-status rule as the alert path.
- `[A]` **Redemption + account creation atomic** — conditional update / D1 transaction, never read-then-write.
  Prove with a **concurrent-request test**, not a single-request pass. A code must never be claimable twice.

**Consumer issuance — RETIRED, superseded by Brief 34 §1.** The webhook below was never wired: no code is
minted on sale at all. The buyer's own Gumroad **licence key IS the access code**, verified against Gumroad's
licence API at signup (`GUMROAD_PRODUCT_ID`), so there is no ping URL to configure and no code to deliver.
~~`POST /webhooks/gumroad/sale`, verified with `ACTIVATION_WEBHOOK_SECRET`; on verified sale generate a code,
insert `issued`/`consumer`, deliver to the buyer; verify the signature fail-closed; configure the Gumroad Ping
URL.~~

**Institutional issuance — admin endpoint:**
- `POST /admin/codes/issue`, gated on `ADMIN_TOKEN` (exists). Accepts `{ count, org_id }`, generates N
  `issued`/`institutional` codes, returns the list.
- **Completely separate from the consumer flow. No Gumroad, no payment, ever.** This is the DV-shelter path.

**Grandfather existing accounts — do NOT lock anyone out:**
- `[A]` Royce and Ikumi (and all pre-gate accounts) predate this. The gate applies to **NEW signups only.**
- `[A]` **Before deploy:** query existing accounts, confirm none are retroactively required to redeem. Confirm
  in the report.

## §D — RELATIONSHIP TO ENTITLEMENT (Brief 28) — don't double-gate

Brief 28 already gates ARM on entitlement. This gates SIGNUP on a code. Confirm the two compose sanely:
- `[A]` A consumer who buys → gets a code → signs up → should also be **entitled to arm** (the code redemption
  should grant Brief 28 entitlement, not leave them signed-up-but-unarmable). Wire redemption → `grantEntitlement`.
- `[A]` Trigger still fires regardless — no signup-gate or entitlement check anywhere in trigger/capture/dispatch.
  Grep-prove.

## REGRESSION

- `[L]` Re-run Brief 13 §B2 (signup) — updated for the required code param; CORS, field validation, no silent
  failures still hold.
- `[L]` Zero regression: Hidden facade byte-identical, trigger/cascade/closure/safety-floor untouched. This
  touches signup + code issuance only.

## REPORT

- What §A deployed (via-only or +dormant); deployed hash.
- §B verdict: extended `enrollment_codes` (preferred) or why a new table was unavoidable.
- Endpoints added; D1 schema diff.
- **Concurrent-request proof of atomic redemption** — not a single-request pass.
- Explicit confirmation Royce/Ikumi still sign in and arm post-deploy.
- Confirmation that code redemption grants entitlement (no signed-up-but-unarmable state).

## DONE
The via fix is deployed and the pre-push gate no longer burns quota; the code model is unified on
`enrollment_codes` (not a second table); signup is gated on atomic code redemption with a consumer Gumroad path
and a separate institutional admin path; existing accounts grandfathered; redemption grants entitlement; trigger
and safety floor untouched. Committed, pushed, both halves currency-asserted.

**Next: the three-role dashboard, on this now-locked code model.**
