-- Brief 23 Fix A §C — ATTRIBUTE EVIDENCE TO THE ORG THAT OWNS IT.
--
-- ═══ WHAT THIS IS FOR, AND WHAT IT IS NOT ════════════════════════════════════════════════════
--
-- NOT access control. Nobody can currently reach another org's data — Brief 23 built server-side
-- scoping at three choke points and it holds. What nobody can currently do is ACCOUNT for an
-- org's data: inventory it, export it, or delete it when a contract terminates. That is what an
-- institutional buyer's counsel asks for and what a DPA commits to, and it is unanswerable today
-- because tenant is reachable only by joining through events/users and no read path does it.
--
-- So this is denormalization for OPERATIONS, and it deliberately adds no predicate to any
-- survivor or coordinator path. /v1/events/* and /v1/c/* stay capability-scoped exactly as they
-- are; tightening them would risk the dashboard a live event depends on.
--
-- ═══ NULL IS A VALUE HERE, NOT A MISSING ONE ═════════════════════════════════════════════════
--
-- Every column added below is NULLABLE and stays that way. A survivor who bought BLACK BOX on
-- Gumroad belongs to no organization; her evidence carries orgId NULL, and that row is COMPLETE,
-- not awaiting a backfill. An earlier draft of this brief proposed NOT NULL after backfill — it
-- was struck, and test/org-nullable.guard.test.ts fails any migration that brings it back.
--
-- ═══ ATTRIBUTION IS FROZEN AT CREATION (§F2) ═════════════════════════════════════════════════
--
-- Rows are stamped from the OWNING EVENT (events.orgId, itself frozen at activation) or the
-- OWNING ACCOUNT (users.orgId). A survivor who later joins or leaves an org does not have her
-- historical evidence re-attributed. That is deliberate and it is what makes a grant audit
-- truthful: the record says which org held custody AT THE TIME, not which org she belongs to now.
--
-- ═══ THIS MIGRATION MOVES NO DATA ════════════════════════════════════════════════════════════
--
-- Columns and indexes only. The backfill is a SEPARATE batched, cursored pass
-- (scripts/backfill-org-attribution.mjs) per §F5, because a single UPDATE across every evidence
-- table is exactly the statement that exceeds a D1 limit mid-flight.
--
-- A DEFAULT IS NOT A BACKFILL. Third occurrence of this class in this codebase (0038 silently
-- un-armed every account; 0049 made five closed events report "in progress"), so it is stated
-- rather than assumed: every existing row receives NULL, and for production that is not an
-- approximation pending correction — it is the CORRECT AND FINAL value. Zero organizations exist
-- on production, every users.orgId and events.orgId is NULL, so there is no org for any existing
-- evidence row to belong to. The backfill script exists for staging, where §D creates two real
-- organizations, and for any future org whose accounts predate its creation.

-- ── Evidence keyed on eventId — attribution flows from events.orgId ──────────────────────────
ALTER TABLE chunks_index ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_org ON chunks_index (orgId);

ALTER TABLE integrity_records ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_integrity_records_org ON integrity_records (orgId);

ALTER TABLE integrity_heads ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_integrity_heads_org ON integrity_heads (orgId);

ALTER TABLE vault_objects ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_vault_objects_org ON vault_objects (orgId);

ALTER TABLE custody_transfers ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_custody_transfers_org ON custody_transfers (orgId);

ALTER TABLE delivery_records ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_delivery_records_org ON delivery_records (orgId);

ALTER TABLE wrapped_keys ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_wrapped_keys_org ON wrapped_keys (orgId);

ALTER TABLE plaintext_commitments ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_plaintext_commitments_org ON plaintext_commitments (orgId);

-- audit_log.eventId is NULLABLE — account-level audit entries carry no event. Those attribute
-- from the acting account instead, and an entry with neither is correctly NULL.
ALTER TABLE audit_log ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log (orgId);

-- ── Keyed on userId — attribution flows from users.orgId ─────────────────────────────────────
--
-- contacts.userId is nullable (0006, sign-up accounts), so a contact can legitimately reach here
-- with no account to attribute from. NULL again, correctly.
--
-- §F4: this column is for INVENTORY ONLY. Contact identity is never scoped by org for dispatch,
-- and DISPATCH IS NEVER ORG-GATED. A survivor's emergency contact may be affiliated with another
-- org or with none, and must still be reached. Nothing in the notification path reads this column.
ALTER TABLE contacts ADD COLUMN orgId TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts (orgId);

-- ── Backfill progress, so a resumed run does not restart from zero (§F5) ─────────────────────
CREATE TABLE IF NOT EXISTS org_backfill_progress (
  tableName TEXT PRIMARY KEY,
  lastKey TEXT,                       -- cursor: the last key processed, NULL before the first batch
  rowsWritten INTEGER NOT NULL DEFAULT 0,
  completedAt INTEGER,                -- NULL while in flight
  updatedAt INTEGER NOT NULL
);
