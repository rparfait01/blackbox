# BRIEF 23 FIX A — TENANCY: ATTRIBUTION, NOT AFFILIATION

**Type:** FIX A on Brief 23 (tenancy)
**Priority:** P1 — blocks the second organization and any institutional contract
**REQUIRES:** Brief 40 §B/§C green (§E depends on the provisioned retention rule and its
readback); Brief 42 green (§C rotation on org membership change); Brief 33 Fix A green (§F4
budgets the two-org pass against its headroom metric); Brief 43 green.
**Ship order:** after Brief 43. Does not block the Okinawa pilot.
**Floor:** all shipped work. Zero regression to trigger, capture, closure, cascade, coordinator
dashboard, custody export, or the consented-purge path.
**Mode:** server-side plus migration.

---

> **THE PRINCIPLE THIS BRIEF IS BUILT ON — read before anything else.**
>
> **An organization is optional. It always has been, and this brief does not change that.**
>
> A consumer who buys BLACK BOX on Gumroad belongs to no shelter, no coalition, and no
> organization. That is a first-class supported state, not a gap to be closed. `orgId` is
> nullable today, every production row is NULL, and **it stays nullable.**
>
> There is no sentinel org. There is no mandatory affiliation. No survivor is placed inside an
> organization to satisfy a schema.
>
> What this brief adds is **attribution for the orgs that do exist** — so a shelter's data can be
> inventoried, exported, and deleted on contract termination. That is an operations requirement
> for institutional licensing. It is not a requirement that anyone have an org.
>
> A prior draft of this brief proposed `orgId NOT NULL` after backfill. **That was wrong and is
> struck.** It would have forced every consumer into an organization and contradicted the product
> line.

---

## §0 — THE RECORD, SINCE BRIEF 23 IS NOT IN THE CORPUS

Brief 23 has no document. Its code shipped. This section is that record, so the corpus gap closes
here rather than staying open.

**Brief 23 built:** `orgId` on `users`, `events`, `enrollment_codes`; the `organizations`,
`org_members`, `org_licenses`, `org_key_grants`, `admin_registration_codes` tables; server-side
`orgId` derivation at three choke points (`requireSession`, `requireOrgRole`,
`deriveConsoleLevel`); `scopedOrg()` predicates on all `/v1/org/*` reads and seven console
handlers; operator as the single deliberate cross-org level.

**Access control is sound and this fix does not change it.** A console coordinator goes through
`scopedOrg(c)`; an event coordinator holds a token HMAC-bound to one event id. Neither can cross
orgs. `orgId` is never taken from a token or a client field on a survivor or coordinator path.

---

## CORRECTIONS

**BRIEF 023 FIX A §B (prior draft) — corrected to read:**
"`orgId` remains nullable on `users`, `events`, and `enrollment_codes`. A NULL `orgId` denotes an
unaffiliated account and is a supported state, not a defect. No constraint, migration, or
validation may require an organization."
Path: `migrations/`

**BRIEF 023 — corrected to read:**
"Tenancy is complete when every row belonging to an organization is attributed to it, unaffiliated
rows remain unaffiliated, and isolation has been proven against two real organizations rather than
zero. Server-side scoping predicates are the mechanism, not the completion."
Path: `workers/api/src/routes/`, `migrations/`

**BRIEF 033 §0 — corrected to read:**
"Console and `/v1/org/*` surfaces are org-scoped server-side. `/v1/me/*` is account-scoped,
`/v1/events/:id/*` is event-scoped by HMAC secret, and `/v1/c/:id/*` is capability-scoped by
event-bound magic token. These are boundaries and they hold — but they are not tenant boundaries
and they confer no tenant attribution on the data they protect."
Path: `workers/api/src/routes/`

---

## THE THREE GAPS (settled — do not re-inventory)

1. **Vacuous.** `organizations` holds 0 rows. Every isolation predicate is satisfied trivially and
   has never separated two real tenants. Untested isolation code is the risk — the same shape as
   `VERIFIED` on an empty chain, closed in Brief 37 Fix A.
2. **No attribution on evidence.** `chunks_index`, `integrity_records`, `integrity_heads`,
   `vault_objects`, `custody_transfers`, `delivery_records`, `audit_log`, `contacts`,
   `wrapped_keys`, `plaintext_commitments` and others carry no tenant column. Where an org exists,
   tenant is reachable only by joining through `events`/`users`, and no read path performs that
   join.
3. **No per-org operations.** Contract-termination deletion, grant audit export, and per-org data
   inventory are unanswerable. That is what an institutional buyer's counsel asks for and what a
   DPA commits to.

**Gap 3 is an operations problem, not an access problem.** Nobody can currently reach another
org's data; nobody can currently *account for* an org's data either.

---

## §A — CREATE THE FIRST ORG

- Create the pilot organization. Bind the accounts and events that genuinely belong to it.
- **Do not bind anything else.** An account with no organization keeps `orgId` NULL. That is the
  correct value, not a missing one.
- Canary account: stays unaffiliated. State that explicitly so a later reader does not treat it as
  an omission.
- **A default is not a backfill.** State what each existing row receives and why — including the
  rows that correctly receive nothing. Third occurrence of this class (0038, 0049); do not make it
  a fourth.

## §B — NULLABLE STAYS NULLABLE

- No `NOT NULL` constraint on `orgId`, anywhere.
- **A guard asserts it:** any migration adding `NOT NULL` to an `orgId` column fails the test
  suite. Structural, per the standing rule — assert against parsed schema, not source text.
- Every query touching `orgId` handles NULL as a first-class value, never as an error or an
  unexpected branch.
- Restore point captured **before the deploy**, not before the operation — a deploy that arms
  automatic behaviour is itself the irreversible act (Brief 40 §F6 precedent).

## §C — ATTRIBUTE EVIDENCE

- Denormalize `orgId` onto the gap-2 tables, written at creation from the owning event or user.
- **NULL propagates.** An unaffiliated survivor's evidence carries a NULL `orgId`, which is
  correct and complete — not a row awaiting an org.
- **Attribution only. Do not add org predicates to `/v1/events/*` or `/v1/c/*`** — those are
  capability-scoped by design and tightening them risks the coordinator path a live event depends
  on.
- Attribution enables three operations that must exist by the end of this brief: per-org data
  inventory, per-org export, per-org deletion on termination.

## §D — PROVE IT NON-VACUOUSLY

The point of the brief. Create a **second** organization on staging with its own accounts, events,
and evidence — **plus at least one unaffiliated account with its own event and evidence.** Then
demonstrate:

- Org A's console cannot read any of org B's rows, on every scoped surface.
- **Neither org's console can read the unaffiliated account's rows.** NULL is not a wildcard, and
  a query written as "not org B" must not sweep up everyone with no org at all. This is the defect
  a nullable column invites, and it is the reason the unaffiliated account is in this test.
- Per-org inventory returns exactly the right rows for each and **excludes the unaffiliated
  account.**
- Per-org deletion removes exactly org A's data and touches nothing of org B's or the
  unaffiliated account's.
- Operator level still crosses all three, by design.

Until this runs, the isolation code is untested rather than proven.

## §E — RETENTION AND PURGE INTERACTION

Resolved in advance — build to this, do not re-derive:

- Two buckets, different rules. `blackbox-media` holds recordings and is deletable.
  `blackbox-vault` holds signed custody manifests and carries the Brief 40 retention rule.
- **A bucket cannot be emptied while lock rules are configured.** Per-org deletion therefore
  removes org A's media and D1 rows and does **not** remove vault manifests.
- Correct, not a conflict: the custody chain is never purged, only the objects it attests to.
  Contract-termination deletion follows the same recorded path as owner-consented purge and
  produces `PURGED_BY_CONSENT` on export.
- **Scope the deletion routine to media plus D1 from the outset.** A routine written to sweep both
  buckets will fail against the lock — design it correctly rather than discovering it at
  acceptance.
- Customer-facing deletion commitment says exactly this: recordings and records are deleted; the
  signed proof that they existed is retained for the stated period.

## §F — ANTICIPATED GAPS

1. **NULL is not a tenant.** Every org-scoped query must exclude NULL rather than treat it as a
   match. A `WHERE orgId != ?` written carelessly returns nothing for NULL rows in SQL — or, worse
   in the other direction, an inventory built as "everything not org B" sweeps in every consumer.
   §D exists to catch both.
2. **A survivor may join or leave an org.** Attribution is written at creation. Historical evidence
   keeps the org it was created under; it is not retroactively re-attributed. State this — it is
   what makes a grant audit truthful.
3. **Org membership change mid-event.** A coordinator whose membership changes during a live alert
   must not lose the dashboard. Membership is evaluated at token issue, not per poll, for the
   duration of a live event.
4. **Cross-org and unaffiliated contacts.** A survivor's emergency contact may be affiliated with a
   different org, or none. Contacts are attributed to the survivor's org — or to nothing — and
   contact identity is never scoped by org for dispatch. **Dispatch is never org-gated.**
5. **Backfill under load.** The migration touches every evidence table. Run it batched with a
   cursor — the Brief 40 §A pattern — never one statement that could exceed a D1 limit mid-flight.
6. **Request cost.** The two-org-plus-unaffiliated isolation pass is a large number of requests.
   Budget it against the Brief 33 Fix A §F headroom metric and run it on staging.

---

## ACCEPTANCE

1. Pilot org created; only genuinely affiliated accounts and events bound. Backfill values stated
   and justified, including the rows correctly left NULL.
2. **`orgId` is still nullable everywhere.** An unaffiliated account is created, arms, triggers,
   captures, and closes normally end to end. Guard fails any migration adding `NOT NULL`.
3. Evidence tables carry attribution; new rows populated at creation; NULL propagates for
   unaffiliated accounts.
4. Backfill ran batched with a cursor; no statement exceeded a D1 limit.
5. **Two-org-plus-unaffiliated staging isolation pass** — every §D item, with queries and
   screenshots. Including: neither org's console reads the unaffiliated account's rows.
6. Per-org inventory, export, and deletion each demonstrated against org A only, excluding both
   org B and the unaffiliated account.
7. Deletion honours §E: media and D1 removed, vault manifests retained, export reads
   `PURGED_BY_CONSENT`.
8. Operator cross-org access intact across all three.
9. Coordinator membership change mid-live-event → dashboard uninterrupted.
10. A contact affiliated with another org, and a contact affiliated with none, both receive
    dispatch.
11. Trigger, capture, closure, cascade, coordinator dashboard, custody export all unaffected.
12. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- **Brief 50** — capture integrity and live relay. Next after this.
- **Brief 51** — device session and arming. Runs in parallel; needs Royce's phone.
- Brief 24 org registration (vetted, invite-only) — the front door for orgs beyond the pilot.
- Brief 26 ZK custody and everything gated on it.
- Brief 0B closure scales. Double-tap gesture items.

---

## CORRECTION ACCEPTED — §B, `enrollment_codes` (2026-08-03)

**§B as written listed `orgId` as remaining nullable on `users`, `events`, and
`enrollment_codes`. `enrollment_codes.orgId` has been `NOT NULL` since migration 0031, and it
stays that way.**

The principle §B protects is that a PERSON may belong to no organization: a survivor who bought
BLACK BOX on Gumroad, whose account, events and evidence carry `orgId NULL` as a complete and
final value. `enrollment_codes` is not that kind of row. A code exists only to enrol someone INTO
a named organization; a code bound to no org does not describe an unaffiliated anything, it is a
corrupt row that would enrol a survivor into nothing.

So the guard (`test/org-nullable.guard.test.ts`) encodes the distinction in BOTH directions:

- **Tenancy-bearing** — `users`, `events`, and the ten evidence tables. `NOT NULL` is FORBIDDEN.
  A migration adding it fails the suite. This is the struck idea from the prior draft, and the
  guard was verified by injecting exactly that migration and watching it fail.
- **Org-structural** — `org_members`, `enrollment_codes`, `org_licenses`, `org_key_grants`,
  `admin_registration_codes`. `NOT NULL` is REQUIRED, and asserted. Making the unsafe state
  unrepresentable applies here too; it just points the other way.

Accepted by Royce 2026-08-03.
