-- BLACK BOX backend schema v31 — Org Tenancy (Brief 23): distribution + purchase.
--
-- Additive + nullable, layered ON TOP of individual accounts. Every existing pilot
-- row stays org-less (orgId NULL = individual, behavior unchanged). Two deliberately
-- distinct membership relationships:
--   * users.orgId  — the org an ACCOUNT belongs to (enrolled survivor OR staff).
--                    NULL = individual. An enrolled SURVIVOR consumes a license seat.
--   * org_members  — STAFF ONLY (admin | coordinator). A plain enrolled survivor is
--                    NOT a member row; they are tracked by users.orgId alone.
--
-- ZERO crypto this brief: organizations.orgPubkey is a reserved forward hook, written
-- nowhere and read nowhere. NO payment: org_licenses is a RECORD ONLY — no checkout,
-- card, or processing exists, and there is no sponsor/funder entity (out of scope).
-- Tenant isolation is enforced in code (requireOrgRole + orgId-filtered /v1/org/*),
-- not by FK constraints — links are by convention/index, as with every prior table.

-- The organization. `lane` is a LABEL ONLY (zero_fee for DV shelters/coalitions; paid
-- for funded institutions) — never a discount, never a price. `orgPubkey` is reserved
-- for a later encryption brief and is unused everywhere today.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,                  -- UUID
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  lane TEXT NOT NULL CHECK (lane IN ('zero_fee','paid')),
  orgPubkey TEXT,                       -- RESERVED forward hook — no crypto this brief
  createdAt INTEGER NOT NULL
);

-- Which org an ACCOUNT belongs to. NULL = individual (the entire current pilot).
-- Additive + nullable: every existing users row stays NULL, behavior unchanged.
ALTER TABLE users ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_users_org ON users (orgId);

-- The org an EVENT belongs to, STAMPED from the owner's users.orgId at creation
-- (POST /v1/events). NULL for account-less events (covert/tokenless, userId NULL) —
-- those stay un-tenanted = individual. Frozen at activation like event_origin (0011),
-- so it survives owner deletion and keeps custody attribution immutable.
-- Backfill is a no-op by construction: no organizations exist yet, so every existing
-- event's owner has orgId NULL. The column default (NULL) is already correct.
ALTER TABLE events ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_events_org ON events (orgId);

-- STAFF membership (admin | coordinator). Enrolled survivors are NOT rows here.
-- status 'revoked' removes access immediately (checked live, never a soft flag).
CREATE TABLE IF NOT EXISTS org_members (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  userId TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','coordinator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_unique ON org_members (orgId, userId);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (userId, status);

-- Enrollment codes bind an account to one org + role. Unguessable, expirable,
-- revocable, usage-bounded. A LEAKED code grants MEMBERSHIP ONLY — never read access
-- to any existing survivor's data (isolation is enforced separately, server-side).
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code TEXT PRIMARY KEY,                -- unguessable random, redeemed verbatim
  orgId TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('survivor','coordinator','admin')),
  expiresAt INTEGER,                    -- NULL = no expiry
  maxUses INTEGER NOT NULL DEFAULT 1,
  usedCount INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,   -- 0/1
  createdBy TEXT,                       -- issuing staff user id
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_org ON enrollment_codes (orgId);

-- License RECORD (purchase path). NO payment processing anywhere — an operator/admin
-- action creates this row. seatsUsed counts ENROLLED SURVIVORS; enrollment past
-- seatsTotal is refused server-side with an admin-facing message.
CREATE TABLE IF NOT EXISTS org_licenses (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  seatsTotal INTEGER NOT NULL DEFAULT 0,
  seatsUsed INTEGER NOT NULL DEFAULT 0,
  termStart INTEGER,
  termEnd INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_licenses_org ON org_licenses (orgId, status);
