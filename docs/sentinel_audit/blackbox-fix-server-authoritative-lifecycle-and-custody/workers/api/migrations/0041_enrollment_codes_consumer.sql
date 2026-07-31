-- BLACK BOX backend schema v41 — ONE code table for both paths (Brief 30 §B).
--
-- The consumer (Gumroad) signup gate needs issued codes. It does NOT get its own
-- table: two tables meaning "an access code" would force every consumer of the model
-- — the dashboard above all — to query and reconcile both, and would drift the moment
-- one gained a column the other lacked. `enrollment_codes` already carries a code, a
-- role, expiry, use-counting, revocation, and an atomic redemption path. The consumer
-- path needs exactly those. So it extends this table.
--
-- ONE genuine obstacle had to be removed: `orgId` was NOT NULL. A consumer code has no
-- organisation — it is a person who bought the product — so the column is rebuilt as
-- nullable. SQLite cannot drop a NOT NULL in place, hence the rebuild (same shape as
-- 0006_contacts_nullable_userhash.sql, the existing precedent).
--
-- The invariant that replaces the lost NOT NULL is stronger than the original, and is
-- enforced by the DATABASE rather than by convention:
--     institutional  ⇒ orgId IS NOT NULL
--     consumer       ⇒ orgId IS NULL
-- so a consumer code can never be silently attached to an org, and an institutional
-- code can never lose its org. Neither mistake is reachable from application code.
--
-- Existing rows (96 at time of writing) are ALL institutional by definition — they
-- predate the consumer path and every one has an orgId — so they grandfather cleanly
-- into `source = 'institutional'` with their orgId intact. No existing code changes
-- meaning, expires, or stops redeeming.

CREATE TABLE enrollment_codes_new (
  code TEXT PRIMARY KEY,
  -- NULLABLE now. NULL is not "missing" — it is what a consumer code means.
  orgId TEXT,
  -- Which issuance path minted this code. Default keeps every pre-existing row, and
  -- any future insert that forgets to say, on the institutional path it came from.
  source TEXT NOT NULL DEFAULT 'institutional' CHECK (source IN ('consumer', 'institutional')),
  role TEXT NOT NULL CHECK (role IN ('survivor', 'coordinator', 'admin')),
  expiresAt INTEGER,
  maxUses INTEGER NOT NULL DEFAULT 1,
  usedCount INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  createdBy TEXT,
  createdAt INTEGER NOT NULL,
  -- Consumer only: where the code was delivered, so a buyer who loses the email can be
  -- helped and a refund can be traced to the code. NULL on institutional codes — a
  -- shelter's codes are not tied to a purchaser.
  buyerEmail TEXT,
  -- Who consumed it, and when. usedCount already says WHETHER it was used; these say
  -- BY WHOM, which is what support and refunds actually need.
  redeemedBy TEXT,
  redeemedAt INTEGER,
  CHECK (
    (source = 'institutional' AND orgId IS NOT NULL) OR
    (source = 'consumer' AND orgId IS NULL)
  )
);

INSERT INTO enrollment_codes_new
  (code, orgId, source, role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt)
  SELECT code, orgId, 'institutional', role, expiresAt, maxUses, usedCount, revoked, createdBy, createdAt
    FROM enrollment_codes;

DROP TABLE enrollment_codes;
ALTER TABLE enrollment_codes_new RENAME TO enrollment_codes;

-- Recreate the index the old table carried (dropped with it), plus one for the
-- consumer path's own lookups.
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_org ON enrollment_codes (orgId);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_source ON enrollment_codes (source, revoked);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_buyer ON enrollment_codes (buyerEmail) WHERE buyerEmail IS NOT NULL;
