# BRIEF 1 of 4 — ACCOUNTS: VERIFY & CERTIFY (individual + organizational identity)

**FLOOR: current known-good. PRODUCTION. LIVE PILOT.**
**VERIFICATION brief. Do NOT rebuild or refactor the accounts layer. Prove what exists. Report gaps. Build only
what §0 or §5 explicitly authorizes.**

**Why first:** Tenancy hangs `org_id` and seats off accounts. Encryption generates keypairs at account and org
creation. If the identity model can't carry a role, Tenancy forces an auth refactor — expensive and risky on a
live safety tool. Certify identity before anything is built on it.

---

## §0 — ARCHITECTURAL DECISION TO CONFIRM (answer before anything else)

**Is identity ONE role-bearing model, or TWO separate identity systems?**

**Required answer: ONE identity model, TWO login surfaces.**

| | |
|---|---|
| **One identity model** | A person is one account. Role (`survivor` / `coordinator` / `admin`) and `org_id` determine what they can reach. |
| **Two login surfaces** | Survivor app entry and org portal entry are separate doors into the same identity layer. |

**Why this is required, not a preference:**
- Shelter staff are frequently survivors themselves. Two identity systems force them into two accounts.
- Two auth systems = two attack surfaces, two recovery flows, two places for a passkey bug to live.
- Tenancy scopes by `org_id` **on the account**. A separate seat-identity table would orphan that scoping.

`[A]` **Report which model is currently implemented.** If it is already one role-bearing model → confirm and
proceed. If it is two systems, or if role/membership cannot attach to an account → **STOP, report, do not
refactor unilaterally.** That is a decision, not a fix.

---

## §1 — VERIFY: passwordless auth (individual)

| # | Case | Expected |
|---|---|---|
| 1 | New account → passkey enroll → sign out → sign in | Passkey works, usernameless, nothing typed |
| 2 | Non-passkey device → magic link | Delivers, redeems, signs in |
| 3 | Magic link on a passkey-enrolled account | **REFUSED at issue AND at redeem**, server-side |
| 4 | Passkey enrolled after magic-link sign-in | Magic link immediately closed for that account |
| 5 | Recovery code | Redeems once, then dead; never emailed |
| 6 | Password field / `/forgot` / `/reset` | Do not exist in UI or routing |

- `[A]` Prove §3 is enforced **at both issue and redeem**, server-side — not UI-hidden. Threat closed: an abuser
  mails themselves a link and spends it after the survivor secures the account.
- `[A]` Report whether any legacy password verifier still exists and whether the pilot is fully migrated.
  **If fully migrated → delete it in a named commit.**

## §2 — VERIFY: individual account management (add / modify / remove / track)

| # | Case | Expected |
|---|---|---|
| 7 | Add / edit / remove contacts | Persists; channel + address correct (SMS number, LINE ID) |
| 8 | LINE-only contact, no phone number | Valid, not flagged incomplete |
| 9 | Edit profile, check-in recipient, mode preference | Persists across sign-out/in |
| 10 | Delete account | Wipes per retention policy; audit metadata retained |
| 11 | Delete account during a live alert | **Blocked** by live-alert lock, honest message shown |
| 12 | Self-view | Own state only; no cross-account visibility by any route |

## §3 — VERIFY: organizational identity capability (the tenancy prerequisite)

This does **not** build the org portal — Tenancy owns that. This verifies the identity layer can *carry* an org.

| # | Case | Expected |
|---|---|---|
| 13 | Account schema | Can an account carry `org_id` + `role` **additively and nullably**, without altering individual behavior? |
| 14 | Role capability | Can one account hold a coordinator/admin role — and can the same person be both survivor and coordinator? |
| 15 | Org-login surface | Separate entry point exists, currently **inert** (no form, no endpoint, no data model) |
| 16 | Auth parity | Would a coordinator sign in with the **same passwordless mechanics** (passkey primary, magic-link fallback, recovery code)? Report yes/no. |
| 17 | Refactor risk | Confirm Tenancy can attach org membership, seats, and enrollment **without refactoring individual auth**. Name any blocker. |
| 18 | Isolation readiness | Confirm there is a single, server-side place where scoping would attach — no query path that would need duplicated filtering |

- `[A]` Deliver an explicit **"Tenancy-ready: YES / NO + blockers"** verdict. This is the deliverable of §3.

## §4 — VERIFY: no regression on the safety floor

- `[L]` Trigger fires in both skins, every ordering, one login, no reload.
- `[L]` Zero-contact trigger still fires + captures; status reads truthfully (no false "notifying").
- `[L]` Closure, check-in, single-active, live-alert lock, currency guard — unregressed.
- `[L]` §0a Hidden facade byte-identical. No account UI, login prompt, or recovery element ever renders in Hidden.

## §5 — BUILD (authorized): SMS opt-in consent line — A2P blocker

The A2P campaign was rejected on **opt-in information**. Carriers require provable, visible consent where a
number is entered. Add adjacent to the phone-number field on the add-contact screen:

> By adding this contact, you confirm they consent to receive BLACK BOX safety text messages.
> Message frequency varies. Message and data rates may apply. Reply STOP to opt out.

- Visible at the moment of entry — not buried in settings or behind a policy link. Screenshot-able for the carrier.
- §0a: Visible/Settings only. Never in Hidden.
- `[L]` Adding an SMS contact displays the consent line before save.

---

## REPORT (single report — no round-trips)

1. §0 verdict: which identity model is implemented.
2. Cases 1–18: PASS / FAIL / NOT-IMPLEMENTED, evidence per row.
3. **Tenancy-ready: YES / NO + named blockers.**
4. Legacy password verifier status; pilot migration status.
5. Deployed hash — **assert Pages and Worker `version.json` match** (the worker step has silently no-op'd twice).

## DONE
Identity model confirmed, 18 cases certified on a real deployed device, Tenancy-ready verdict delivered, opt-in
consent line shipped, zero regression on the safety floor, both deploy halves currency-asserted. Royce phone
sign-off. **Brief 2 does not begin until this report is green and Tenancy-ready is YES.**
