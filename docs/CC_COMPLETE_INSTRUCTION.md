# CC — COMPLETE INSTRUCTION (close everything open, no loose ends)

Standing constraints apply. Migration→deploy order, both halves currency-asserted, safety floor untouched,
§0a Hidden byte-identical. Prove every [L] on the real surface, not curl. Close every gap; no orphan flags.
Re-assert deploy currency at the start (HEAD was one test-only commit ahead of worker).

## 0 — FIX THE WRONG OPERATOR GRANT (do first)
- `royce.parfait@outlook.com` is a PURCHASED CONSUMER account, wrongly granted operator. Revoke it —
  `platform_role` → null.
- `developer@blackboxsentinel.com` is the SOLE operator. Display name "Developer Blackboxsentinel".
- Prove: royce.parfait@outlook.com → /v1/admin/* → 401; developer@ → /v1/admin/* → 200.
- Prove: royce.parfait@outlook.com still works as a normal entitled consumer — signs in, arms, triggers.

## 1 — ACCOUNT LEVEL INDICATOR (existing fields, UI label only — do NOT invent roles)
FIELDS (unchanged, keep as built):
- `platform_role` = 'operator' | null
- `org_members.role` = 'admin' | 'coordinator'

UI LABEL per account row:
- platform_role='operator'        -> **DEV**
- org_members.role='admin'        -> **ADMIN**
- org_members.role='coordinator'  -> **COORD**
- neither (null + no org row)      -> **UNMARKED**

Do NOT rename the operator field - it's CHECK-constrained. "DEV" is display only.
Every account row in the console shows its level. developer@ -> DEV. royce.parfait@outlook.com -> UNMARKED.

## 2 — LICENCE-KEY WORDING FIX
- On reuse of a Gumroad licence key, the message says "access code" - pass the credential kind through so a
  licence key says "licence key" and an institutional code says "access code". Honest and precise.

## 3 — 33b CONSOLE (build against docs/BLACKBOX_dashboard_mockup.html, one pass)
- Three roles, one shell, role decided server-side from the authenticated session:
  - **DEV/operator** - all orgs, create/vet org, issue/revoke admin codes, system-wide counters, account level
    indicators visible.
  - **ADMIN** - their org only: seats (min-2 enforced), all org codes, enrollments/readiness, org metrics.
  - **COORD** - their org only: issue enrollment codes, their own roster.
- [A] Every query scoped SERVER-SIDE by role + org_id. Operator is the only cross-org view.
- [A] No role - including operator - can read incident content. Counters only.
- [L] Prove cross-org refusal adversarially (org admin cannot reach another org by any route).
- [L] Prove content-read refused for every role.
- Code operations reuse the unified enrollment_codes + shared atomic primitive. No new code system.
- §0a: console never renders in the Hidden facade.

## 4 — 33c MAINTENANCE PANEL (DEV/operator only - buttons over proven endpoints)
Every maintenance action a button, audited (who/what/when), destructive actions dry-run-default + explicit confirm:
- **Issue code** (stops manual curl issuance)
- **R2 purge** (dry-run preview -> confirm; the existing endpoint)
- **System health** (D1/R2 status, deployed hash, Pages==Worker currency)
- **Create/vet org** (returns the one-time admin registration code)
- **Admin codes** (issue/reissue/revoke)
- **Account deletion** (the cascading deleteAccount - no orphaned events/R2)
- **Deploy/migration state** (what's live vs pending)

## 5 — CONFIRM OPERATOR REAL-UI SIGN-IN
- After Royce signs in as developer@ via the real magic-link/passkey ceremony, confirm the operator session
  reaches /v1/admin/* from the browser (not a synthesized session). This closes 33a's last mile.
- If the sign-in flow has any client/server gap like §C's onboarding did, close it.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Per item: real-surface proof, not curl. Deployed hash, both halves asserted.
Every open item ends with who closes it and how - no dangling flags.

## STILL ON ROYCE (name these in the report so they're not lost, don't mark them done)
- `wrangler secret delete GUMROAD_PRODUCT_ID` (var supplies it now; two sources for one binding)
- Gumroad auto-issue is retired by design - licence key on the receipt IS the credential; no webhook needed.
  Confirm nothing still references the dead /webhooks/gumroad/sale path.
- Real-UI operator sign-in click (item 5) - Royce performs, CC confirms.
