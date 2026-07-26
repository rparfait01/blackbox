-- BLACK BOX backend schema v42 — operator identity (Brief 33a).
--
-- Until now "operator" was not an identity at all: it was possession of ADMIN_TOKEN, a
-- bearer secret with no account behind it. That has two consequences the console cannot
-- live with:
--
--   1. You cannot SIGN IN as operator. There is no account to sign in as, so a role-gated
--      console could only be reached by pasting a token into a browser — which the
--      standing constraints call a temporary state to be designed out, not an end state.
--   2. Nothing is attributable. Every audited operator action records a null actor,
--      because a token is not a person. "Who purged R2?" has no answer.
--
-- platform_role is deliberately SEPARATE from org_members.role (admin | coordinator).
-- Those are roles WITHIN one organisation and are scoped by orgId. This is a PLATFORM
-- role that is cross-org by nature — the only one that is — so putting it in org_members
-- would have required a fake org to hang it from, and would have made "operator" look
-- like just another tenant role in every query that joins that table.
--
-- NULL is the overwhelming default and means "no platform role": every survivor, every
-- org admin, every coordinator. Only an operator row is non-null, so the column adds no
-- meaning to any existing account and cannot silently promote anyone.
ALTER TABLE users ADD COLUMN platform_role TEXT
  CHECK (platform_role IS NULL OR platform_role IN ('operator'));

-- Partial index: operators are a handful of rows in a table of survivors, and the only
-- query that uses this column asks "is this account an operator?".
CREATE INDEX IF NOT EXISTS idx_users_platform_role
  ON users (platform_role) WHERE platform_role IS NOT NULL;
