-- Brief 30 Fix A §B — single-use signup capabilities.
--
-- `signupId` was the account's permanent users.id, accepted as authorization by finalize,
-- passkey registration and recovery-code issuance, none of which checked the account was still a
-- draft. Proven on staging: that value alone returned a valid session for an ACTIVE account,
-- flipped a covert user to direct, and re-minted recovery codes over the owner's set.
--
-- A capability replaces it: signed, scoped, expiring, and — for steps that are not idempotent —
-- spent exactly once. This table is what "once" means. The primary key is the whole mechanism:
-- two concurrent replays race on the INSERT and only one can win.
--
-- It stores the capability's IDENTIFIER, never the token (§C).
CREATE TABLE IF NOT EXISTS consumed_capabilities (
  jti        TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  consumedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_capabilities_user ON consumed_capabilities (userId);
-- Consumed rows are only interesting until the capability would have expired anyway; this index
-- lets a later cleanup pass age them out without a full scan.
CREATE INDEX IF NOT EXISTS idx_consumed_capabilities_at ON consumed_capabilities (consumedAt);
