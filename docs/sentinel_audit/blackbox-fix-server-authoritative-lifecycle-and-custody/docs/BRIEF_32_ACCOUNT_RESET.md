# BRIEF 32 — ACCOUNT RESET + OPERATOR ROLE

**Clean the prod account table to a single operator account (Royce), and provision top-level operator access
so Royce can vet and create organizations. Precedes §C and the dashboard.**
**Destructive to prod data — restore point FIRST, scoped deletes, no blind wipe.**

---

## §1 — CAPTURE A RESTORE POINT FIRST

- `[A]` Take a D1 Time Travel bookmark before any delete. Record it in the report. This is non-negotiable —
  account deletion is irreversible without it.

## §2 — IDENTIFY WHAT SURVIVES

- **Exactly one account survives: Royce's operator account.** Confirm which email/account id that is before
  deleting anything — state it in the report and get it right.
- `[A]` Everything else goes: Dominick, Teresa (terekei), yuinashimizu, developer, all `smoke+%`, all test orgs,
  all their members/codes/events/contacts. These are pilot/test residue, not live users.

## §3 — SCOPED DELETES (not a blind wipe)

Delete in FK-safe order, each scoped, each counted before/after:

1. Events + locations + captures for all non-Royce accounts
2. Contacts for all non-Royce accounts
3. `org_members`, `org_licenses`, `enrollment_codes`, registration codes for all orgs
4. `organizations` (all — Royce will create real ones fresh)
5. All accounts except Royce's operator account
6. Any entitlement / delivery / audit rows orphaned by the above

- `[A]` Report row counts before → after for every table touched.
- `[A]` **Confirm Royce's account survives intact** — account, passkey, entitlement, contacts. Prove it post-delete.

## §4 — PROVISION OPERATOR ROLE

Royce needs top-level operator access — distinct from org roles — to vet and create organizations.

- `[A]` Report first: how is "operator" represented today? Is there an operator/developer level distinct from
  `admin`/`coordinator`, or does operator power currently come only from `ADMIN_TOKEN` on admin endpoints?
- **If operator is only `ADMIN_TOKEN` today:** that's fine as the mechanism for now — confirm Royce can call the
  operator endpoints (create org, issue admin code) with it. Do NOT invent a new role system in this brief if the
  token already grants operator power; just confirm the path works end to end.
- **If a role field exists:** set Royce's account to the operator/top level, and confirm it grants org
  vetting/creation without granting any single org's scope (operator is cross-org by nature).
- `[A]` The operator path must let Royce: create an org record, issue a one-time admin code (Brief 24), and see
  system-wide state. Confirm each works against the live worker.

## §5 — GUARDS

- `[A]` Royce's account still signs in (passkey), still arms, still triggers post-reset. The safety floor on the
  surviving account is unregressed.
- `[A]` §0a Hidden facade untouched. No trigger/capture/closure code touched — this is data + role only.
- `[A]` No new account can be created yet if §C (signup gate) is pending — note the interaction, don't break it.

## REPORT

- Restore bookmark.
- Row counts before → after, every table.
- Confirmation Royce's account survived with passkey + entitlement + contacts intact.
- How operator access is granted (token vs role) and proof Royce can create an org + issue an admin code live.
- Deployed hash if any deploy was needed; both halves currency-asserted.

## DONE
Prod reduced to a single operator account (Royce) with a restore point captured, all test/pilot residue removed
by scoped deletes, and operator-level access confirmed so Royce can vet and create organizations. Royce's safety
floor unregressed. Committed, pushed.

**Next: §C signup gate, then the three-role dashboard for org self-management.**
