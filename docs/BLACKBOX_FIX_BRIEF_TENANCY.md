# BLACK BOX — FIX BRIEF (assign next free git number) — ORG TENANCY + SEATS (the data block)

**Authored now; DO NOT execute until:** the trigger/closure floor is `known-good` AND Section 1 (Accounts) has
shipped. **Depends on the account model** (org_id hangs on accounts; seats reference users).
**Isolation rule:** this brief establishes the org entity and RESERVES an org-public-key column as a forward
hook only. It implements ZERO cryptography. The encryption brief owns all crypto. Do not stack them.
**PRODUCTION. LIVE PILOT. ZERO REGRESSION** — the current individual-account pilot must be untouched.

**Purpose:** multi-org tenancy so the institutional lane works — each org is a tenant; coordinators are scoped
to their own org's survivors. This is what turns free pilots into grant-funded institutional procurement.

---

## §1 — Data model (additive, live-safe migration)
- `organizations(id, name, status, lane, created_at, org_pubkey NULL)` — `lane` = zero-fee | paid (fee schedule,
  billing deferred). `org_pubkey` is a RESERVED forward hook for the encryption brief — nullable, no crypto
  logic here.
- `accounts.org_id` — nullable FK → organizations. **NULL = individual user (current pilot behavior, unchanged).**
- `org_members(org_id, user_id, role, status, created_at)` — role = admin | coordinator. Who operates the org's
  dashboard.
- `enrollment_codes(code, org_id, role, expires_at, max_uses, used_count, revoked, created_by)` — enrollment of
  survivors/seats into an org.

## §2 — Tenant isolation (the paramount property)
- EVERY event / survivor / capture / dashboard query is scoped **server-side** by `org_id`. A coordinator in org
  A must NEVER see org B's events, survivors, captures, or locations. Server-enforced — never client filtering.
- Individual accounts (`org_id` NULL) are their own isolation domain, invisible to any org.
- There is no unscoped query path to survivor/event/capture data. Audit every such route for an org_id filter.

## §3 — Enrollment
- Enroll by code → binds an account (survivor) or seat (coordinator/admin) to one org.
- Codes are unguessable, expirable, revocable, usage-bounded. A leaked code must not expose existing survivors —
  enrollment grants membership, never read access to others' data.

## §4 — Dashboard scoping
- Coordinator dashboard = that org's active events + enrolled survivors only. Admin manages seats. Least
  privilege per role.

---

## PRODUCTION SAFETY / MIGRATION
Additive, nullable `org_id`. Existing pilot accounts stay individual (`org_id` NULL) with zero behavior change.
Prove the pilot's individual flows are untouched.

## DECISIONS REQUIRED (Royce)
1. Can an existing individual account later join an org (migration into a tenant), or is org membership set at
   enrollment only?
2. `lane` enum now (zero-fee | paid) or defer the field entirely until billing?

## ACCEPTANCE
- `[L]` Two orgs; cross-tenant isolation proven — org A cannot query org B's events / survivors / captures /
  locations by any route.
- `[L]` Enrollment: valid code → correct org + role; expired / revoked / over-limit codes rejected.
- `[L]` Individual (`org_id` NULL) accounts unaffected — pilot regression check.
- `[A]` Every event/dashboard/survivor/capture query carries an org_id scope; no unscoped path exists.
- `[A]` `org_pubkey` column exists, unused, with no crypto logic in this brief.

**Dependency chain:** Accounts → THIS → Encryption. Do not begin until Accounts has shipped.
