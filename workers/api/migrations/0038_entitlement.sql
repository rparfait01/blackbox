-- BLACK BOX backend schema v38 — Entitlement & Activation (Brief 28).
--
-- Activation is how BLACK BOX gets paid: a one-time web purchase, an org enrollment
-- code, an iOS in-app purchase, or an operator grant. The governing rule (§0) is
-- SAFETY-CRITICAL and inverts the usual paywall logic:
--
--   The paywall gates ARM. It NEVER gates the trigger. No entitlement check exists
--   anywhere in the trigger, capture, or dispatch path. Entitlement never expires,
--   never re-checks, works fully offline after first activation, and an org license
--   lapsing NEVER deactivates an already-activated survivor.
--
-- These three columns are the whole model. Additive + defaulted so every existing
-- pilot row is 'unactivated' with a NULL source — behavior unchanged until the arm
-- affordance reads them (armable, GET /v1/me/contacts). They are read to decide the
-- ARM affordance only; POST /v1/events never reads them.
--
--   entitlement        — 'unactivated' | 'activated'. One-way: once 'activated' it is
--                        NEVER set back (permanent, the §0 no-re-lock guarantee).
--   entitlement_source — how it was activated (audit + never-render-price for org).
--                        NULL while unactivated.
--   activatedAt        — when it flipped to 'activated'. NULL while unactivated.
ALTER TABLE users ADD COLUMN entitlement TEXT NOT NULL DEFAULT 'unactivated'
  CHECK (entitlement IN ('unactivated','activated'));
ALTER TABLE users ADD COLUMN entitlement_source TEXT
  CHECK (entitlement_source IN ('purchase_web','purchase_ios','org_code','operator_grant'));
ALTER TABLE users ADD COLUMN activatedAt INTEGER;

-- Web-purchase activation records (Brief 28 §3). A signature-verified payment webhook
-- writes ONE row here per completed purchase, keyed by the provider's own event id
-- (idempotency: a re-delivered webhook UPDATEs, never duplicates). The account is
-- matched by email at grant time; a payment whose email has no account yet is stored
-- with accountUserId NULL and surfaced loudly (audit 'activation_orphan') for operator
-- recovery — a paid purchase is NEVER silently dropped.
--
-- Server-verified ONLY: no client redirect or client claim ever writes an activation.
CREATE TABLE IF NOT EXISTS activation_receipts (
  providerEventId TEXT PRIMARY KEY,     -- the payment provider's unique event id
  provider TEXT NOT NULL,               -- 'stripe' | 'manual' | ... (label)
  email TEXT,                           -- purchaser email (normalized), for matching
  accountUserId TEXT,                   -- resolved account (NULL = orphan, unmatched)
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','granted','orphan')),
  amountCents INTEGER,                  -- record only
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activation_receipts_email ON activation_receipts (email);
CREATE INDEX IF NOT EXISTS idx_activation_receipts_account ON activation_receipts (accountUserId);
