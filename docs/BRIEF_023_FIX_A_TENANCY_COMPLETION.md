# BRIEF 23 FIX A — TENANCY: MAKE THE BOUNDARY NON-VACUOUS

**Type:** FIX A on Brief 23 (tenancy)
**Priority:** P1 — blocks the second organization and any institutional contract
**REQUIRES:** Brief 40 §B/§C green (§E depends on the provisioned retention rule and its readback);
Brief 42 green (§C rotation on org membership change); Brief 33 Fix A green (§F5 budgets the
two-org pass against its headroom metric). The full audit set (through Brief 43) should be green
first — this is the last brief in the queue.
**Ship order:** TENTH. Does not block the Okinawa pilot.
**Floor:** Briefs 35–43. Zero regression to trigger, capture, closure, cascade, coordinator
dashboard, custody export, or the consented-purge path.
**Mode:** server-side plus migration.

---

## §0 — THE RECORD, SINCE BRIEF 23 IS NOT IN THE CORPUS

Brief 23 has no document. Its code shipped. This section is the record of what it built, so the
gap in the corpus is closed here rather than left open.

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

**BRIEF 023 — corrected to read:**
"Tenancy is complete when a tenant exists, cannot be absent, is attributed to every row that
belongs to one, and has been proven to isolate two real organizations. Server-side scoping
predicates alone are the mechanism, not the completion."
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
   has never separated two real tenants. Untested isolation code is the risk.
2. **Nullable, all NULL.** `users`, `events`, `enrollment_codes` permit un-tenanted rows and every
   production row is one.
3. **No attribution on evidence.** `chunks_index`, `integrity_records`, `integrity_heads`,
   `vault_objects`, `custody_transfers`, `delivery_records`, `audit_log`, `contacts`,
   `wrapped_keys`, `plaintext_commitments` and others carry no tenant column. Tenant is reachable
   only by joining through `events`/`users`, and no read path performs that join.

**Gap 3 is an operations problem, not an access problem.** Contract-termination deletion, grant
audit export, and per-org data inventory are currently unanswerable. That is what an institutional
buyer's counsel asks for, and what a DPA commits you to.

---

## §A — CREATE THE FIRST ORG AND BACKFILL

- Create the pilot organization. Bind the real accounts and their events.
- Backfill `orgId` on `users`, `events`, `enrollment_codes`.
- **A default is not a backfill.** State explicitly what existing rows receive and why. Third
  occurrence of this class (0038, 0049) — do not make it a fourth.
- Canary account: decide and state whether it belongs to an org or is deliberately un-tenanted.

## §B — CONSTRAIN

- `orgId` becomes `NOT NULL` on `users`, `events`, `enrollment_codes` after backfill.
- Migration reversible; restore point captured **before the deploy**, not before the operation —
  a deploy that arms automatic behaviour is itself the irreversible act (Brief 40 §F6 precedent).

## §C — ATTRIBUTE EVIDENCE

- Denormalize `orgId` onto the gap-3 tables, written at creation from the owning event or user.
- **Attribution only. Do not add org predicates to `/v1/events/*` or `/v1/c/*`** — those are
  capability-scoped by design and tightening them risks the coordinator path a live event depends
  on.
- Attribution enables three operations that must exist by the end of this brief: per-org data
  inventory, per-org export, per-org deletion on termination.

## §D — PROVE IT NON-VACUOUSLY

The point of the brief. Create a **second** organization on staging with its own accounts, events,
and evidence, then demonstrate:

- Org A's console cannot read any of org B's rows, on every scoped surface.
- Per-org inventory returns exactly the right rows for each.
- Per-org deletion removes exactly org A's data and touches nothing of org B's.
- Operator level still crosses both, by design.

Until this runs, the isolation code is untested rather than proven.

## §E — RETENTION AND PURGE INTERACTION

Resolved in advance — build to this, do not re-derive:

- Two buckets, different rules. `blackbox-media` holds recordings and is deletable.
  `blackbox-vault` holds signed custody manifests and carries the Brief 40 retention rule.
- **A bucket cannot be emptied while lock rules are configured.** Per-org deletion therefore
  removes org A's media and D1 rows and does **not** remove vault manifests.
- That is correct, not a conflict: the custody chain is never purged, only the objects it attests
  to. Contract-termination deletion follows the same recorded path as owner-consented purge and
  produces `PURGED_BY_CONSENT` on export.
- **Scope the deletion routine to media plus D1 from the outset.** A routine written to sweep both
  buckets will fail against the lock — design it correctly rather than discovering this at
  acceptance.
- The customer-facing deletion commitment says exactly this: recordings and records are deleted;
  the signed proof that they existed is retained for the stated period.

## §F — ANTICIPATED GAPS

1. **A survivor can belong to no org.** Consumer accounts via Gumroad have no organization. Decide
   now: a reserved sentinel org for unaffiliated consumers, or `orgId` nullable for consumers and
   `NOT NULL` only where an org path applies. **Do not force every survivor into an org** — the
   consumer path is a real product line and this decision constrains it.
2. **Org membership change mid-event.** A coordinator whose membership changes during a live alert
   must not lose the dashboard. Membership is evaluated at token issue, not per poll, for the
   duration of a live event.
3. **Cross-org contacts.** A survivor's emergency contact may be a person affiliated with a
   different org, or none. Contacts are attributed to the survivor's org, and contact identity is
   never scoped by org for dispatch. Dispatch is never org-gated.
4. **Backfill under load.** The migration touches every evidence table. Run it against a bounded
   batch with a cursor — the Brief 40 §A pattern — not as one statement that could exceed a D1
   limit mid-flight.
5. **Request cost.** The two-org isolation pass is a large number of requests. Budget it against
   the Brief 33 Fix A §F headroom metric and run it on staging.

---

## ACCEPTANCE

1. §F1 answered and stated: how unaffiliated consumer accounts are represented.
2. Pilot org created; real accounts and events bound; backfill values stated and justified.
3. `NOT NULL` in force where §F1 says it applies; an un-tenanted insert is refused there.
4. Evidence tables carry attribution; new rows populated at creation.
5. Backfill ran batched with a cursor; no statement exceeded a D1 limit.
6. **Two-org staging isolation pass** — every §D item, with queries and screenshots.
7. Per-org inventory, export, and deletion each demonstrated against org A only.
8. Deletion honours §E: media and D1 removed, vault manifests retained, export reads
   `PURGED_BY_CONSENT`.
9. Operator cross-org access intact.
10. Coordinator membership change mid-live-event → dashboard uninterrupted.
11. A contact affiliated with another org still receives dispatch.
12. Trigger, capture, closure, cascade, coordinator dashboard, custody export all unaffected.
13. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Brief 24 org registration (vetted, invite-only) — the front door for orgs beyond the pilot.
- Brief 26 ZK custody and everything gated on it.
- Brief 0B closure scales. Double-tap gesture items.
