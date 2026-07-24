-- BLACK BOX backend schema v33 — Org Registration (Brief 24). The vetted, invite-only
-- FRONT DOOR for an organization: a single-use, admin-only code that claims the first
-- admin seat on a PRE-CREATED org. Org registration is never self-serve — an abuser
-- registering a fake shelter to reach survivors is the worst-case compromise, so human
-- vetting (out-of-band, by the operator) is the control, and the org record already
-- exists before any code is issued.
--
-- DELIBERATELY A SEPARATE TABLE from enrollment_codes (Brief 23). A registration code
-- can NEVER confer a coordinator seat, and an enrollment code can NEVER confer admin —
-- the separation is structural, not a role flag on a shared table. The two ceremonies
-- also differ fundamentally: enrollment is redeemed by an existing signed-in account;
-- registration CREATES the first admin account.
CREATE TABLE IF NOT EXISTS admin_registration_codes (
  code TEXT PRIMARY KEY,              -- unguessable random; delivered SEPARATELY from the link
  orgId TEXT NOT NULL,               -- the specific pre-created org this code claims admin #1 on
  expiresAt INTEGER NOT NULL,        -- REQUIRED, short (default 14 days) — never a standing code
  revoked INTEGER NOT NULL DEFAULT 0,-- operator may revoke any time before redemption
  redeemedAt INTEGER,                -- set once, on the explicit completion POST — single-use
  redeemedByUserId TEXT,             -- who redeemed (recorded for audit)
  attemptCount INTEGER NOT NULL DEFAULT 0, -- redemption attempts, for server-side rate limiting
  lastAttemptAt INTEGER,
  reissueReason TEXT,                -- set when this code was issued as a replacement (§6, logged)
  createdBy TEXT,                    -- issuing operator (null = ADMIN_TOKEN operator)
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_reg_codes_org ON admin_registration_codes (orgId);

-- License acceptance record (§4): who accepted/signed, when, the license version, and
-- WHICH path applied (click-through for zero-fee; out-of-band signature for paid, where
-- the DPA lives). Additive + nullable on the existing organizations row.
ALTER TABLE organizations ADD COLUMN licenseAcceptedBy TEXT;      -- userId of the accepting admin #1
ALTER TABLE organizations ADD COLUMN licenseAcceptedAt INTEGER;
ALTER TABLE organizations ADD COLUMN licenseVersion TEXT;
ALTER TABLE organizations ADD COLUMN licenseAcceptancePath TEXT;  -- 'click_through' | 'out_of_band'
