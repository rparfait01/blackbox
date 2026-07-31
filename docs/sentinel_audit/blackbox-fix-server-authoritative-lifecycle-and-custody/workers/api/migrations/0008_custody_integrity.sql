-- BLACK BOX backend schema v8 (Fix Brief 2). Custody, identity & integrity.
-- Canonical time is ALWAYS UTC ms + tzOffsetMinutes (C6); local/DTG are render-
-- only. Every table below carries createdAt (UTC) + tzOffsetMinutes.

-- C1 — Recipient identity (mint-on-access). A recipient is a verified human who
-- claimed a dispatch/export token. Immutable id RCP-<uuid>; append-only.
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,                 -- RCP-<uuid>
  fullName TEXT NOT NULL,
  agency TEXT NOT NULL,                -- organization / agency
  roleRef TEXT,                        -- role or badge reference
  contactType TEXT NOT NULL,           -- 'email' | 'phone'
  contactValue TEXT NOT NULL,          -- normalized contact
  verificationStatus TEXT NOT NULL,    -- 'pending' | 'verified'
  verifiedAt INTEGER,                  -- UTC ms when the challenge was answered
  firstSeenAt INTEGER NOT NULL,        -- UTC ms first claim
  tzOffsetMinutes INTEGER
);

-- Binds a recipient to a specific access token + scope, and to the event the
-- token grants. One row per (token) claim. Append-only.
CREATE TABLE IF NOT EXISTS recipient_bindings (
  id TEXT PRIMARY KEY,
  recipientId TEXT NOT NULL,
  eventId TEXT NOT NULL,
  scope TEXT NOT NULL,                 -- 'dispatch' | 'export'
  tokenHash TEXT NOT NULL,             -- sha256 of the claimed token (never the token)
  boundAt INTEGER NOT NULL,            -- UTC ms
  tzOffsetMinutes INTEGER
);

-- Append-only log of every action a recipient takes once identified.
CREATE TABLE IF NOT EXISTS recipient_actions (
  id TEXT PRIMARY KEY,
  recipientId TEXT NOT NULL,
  eventId TEXT,
  action TEXT NOT NULL,                -- 'register' | 'verify' | 'view' | 'export' | 'challenge_answered' | ...
  detail TEXT,
  createdAt INTEGER NOT NULL,          -- UTC ms
  tzOffsetMinutes INTEGER
);

-- C2 — integrity hash chain. One append-only row per hashed record (each media
-- chunk, the event row, etc). Each row carries the prior row's hash, so any
-- alteration breaks the chain from that point. The signed head lives in
-- integrity_heads.
CREATE TABLE IF NOT EXISTS integrity_records (
  eventId TEXT NOT NULL,
  seq INTEGER NOT NULL,                -- 0-based position in this event's chain
  recordType TEXT NOT NULL,            -- 'chunk' | 'event' | 'location' | ...
  recordRef TEXT NOT NULL,             -- e.g. r2Key or 'event:<id>'
  recordHash TEXT NOT NULL,            -- sha256 of the record bytes/canonical row
  prevHash TEXT NOT NULL,              -- chain link (genesis = 64 zeros)
  chainHash TEXT NOT NULL,             -- sha256(prevHash + recordHash)
  createdAt INTEGER NOT NULL,
  tzOffsetMinutes INTEGER,
  PRIMARY KEY (eventId, seq)
);

-- Current signed head of each event's chain. Signature is Ed25519 over chainHead
-- (server-held private key; verifier holds the public key).
CREATE TABLE IF NOT EXISTS integrity_heads (
  eventId TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,                -- seq of the latest record
  chainHead TEXT NOT NULL,             -- latest chainHash
  signature TEXT,                      -- Ed25519(chainHead), base64 — set at seal/export
  updatedAt INTEGER NOT NULL,
  tzOffsetMinutes INTEGER
);

-- C3 — custody transfers + sealed vault references.
CREATE TABLE IF NOT EXISTS custody_transfers (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  recipientId TEXT NOT NULL,
  packageHash TEXT NOT NULL,           -- sha256 of the full exported package
  manifestHash TEXT NOT NULL,          -- sha256 of the signed manifest
  vaultKey TEXT NOT NULL,              -- R2 key of the sealed original
  createdAt INTEGER NOT NULL,          -- UTC ms (custody DTG source)
  tzOffsetMinutes INTEGER,
  acknowledgedAt INTEGER               -- set if the recipient acknowledges custody
);

-- Sealed vault objects (write-once, 36-month retention). The bytes live in R2
-- (VAULT bucket); this row is the index + retention clock.
CREATE TABLE IF NOT EXISTS vault_objects (
  vaultKey TEXT PRIMARY KEY,           -- R2 key in the VAULT bucket
  eventId TEXT NOT NULL,
  packageHash TEXT NOT NULL,           -- sha256 of the sealed package
  sealedAt INTEGER NOT NULL,           -- UTC ms
  expiresAt INTEGER NOT NULL,          -- sealedAt + 36 months; no delete before this
  lastVerifiedAt INTEGER,              -- last integrity scan that re-hashed and matched
  tzOffsetMinutes INTEGER
);

-- C4 — tamper investigations.
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  eventId TEXT,
  recipientId TEXT,
  kind TEXT NOT NULL,                  -- 'vault_mismatch' | 'recipient_challenge_failed' | ...
  detail TEXT,
  status TEXT NOT NULL,                -- 'open' | 'resolved'
  openedAt INTEGER NOT NULL,
  resolvedAt INTEGER,
  resolution TEXT,
  tzOffsetMinutes INTEGER
);

-- C5 — trust records per recipient and per agency.
CREATE TABLE IF NOT EXISTS trust_records (
  subjectType TEXT NOT NULL,           -- 'recipient' | 'agency'
  subjectId TEXT NOT NULL,             -- recipientId or agency name
  identityVerified INTEGER NOT NULL DEFAULT 0,
  custodyAcknowledged INTEGER NOT NULL DEFAULT 0,
  challengesIssued INTEGER NOT NULL DEFAULT 0,
  challengesAnswered INTEGER NOT NULL DEFAULT 0,
  investigationsCooperated INTEGER NOT NULL DEFAULT 0,
  investigationsTotal INTEGER NOT NULL DEFAULT 0,
  responseLatencyMsTotal INTEGER NOT NULL DEFAULT 0,
  responseLatencyCount INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  tzOffsetMinutes INTEGER,
  PRIMARY KEY (subjectType, subjectId)
);

CREATE INDEX IF NOT EXISTS idx_recipient_bindings_event ON recipient_bindings (eventId);
CREATE INDEX IF NOT EXISTS idx_recipient_actions_recipient ON recipient_actions (recipientId, createdAt);
CREATE INDEX IF NOT EXISTS idx_custody_event ON custody_transfers (eventId);
CREATE INDEX IF NOT EXISTS idx_vault_event ON vault_objects (eventId);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations (status, openedAt);

-- C2: add hash + chain columns to chunks_index so a chunk carries its own hash
-- inline (the integrity_records chain references these).
ALTER TABLE chunks_index ADD COLUMN sha256 TEXT;

-- C6: stamp tz offset onto the high-frequency indexes so every record renders
-- in the event's local time without a join.
ALTER TABLE chunks_index ADD COLUMN tzOffsetMinutes INTEGER;
ALTER TABLE locations_index ADD COLUMN tzOffsetMinutes INTEGER;
