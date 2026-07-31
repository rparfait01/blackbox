-- BLACK BOX backend schema v5 (W8A) — sign-up identity.
--
-- The anonymous device UUID is no longer the account. A person signs up with a
-- verified email + captured (unverified) phone, chooses a display mode, and sets
-- a lock code (+ optional duress code). The account persists as a `users` row
-- reached by an HMAC session token. Existing pilot data is preserved: events and
-- contacts keep `userHash` and gain a nullable `userId` so the admin's sign-up
-- can claim them.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- UUID
  name TEXT,                           -- full name or alias (shown in alert subjects)
  phone TEXT,                          -- E.164, captured but UNVERIFIED in v0
  email TEXT UNIQUE,                   -- lowercased
  phoneVerifiedAt INTEGER,             -- always null in v0 (SMS deferred)
  emailVerifiedAt INTEGER,             -- set by the email OTP step
  displayMode TEXT CHECK (displayMode IN ('direct','covert')),
  regionId TEXT,                       -- FK to regions.id
  lockCodeHash TEXT,                   -- PBKDF2; ends the alert via contact approval
  duressCodeHash TEXT,                 -- PBKDF2; nullable; signals duress
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS otp_codes (
  identifier TEXT NOT NULL,            -- the email (lowercased) the code was sent to
  codeHash TEXT NOT NULL,              -- PBKDF2 of the 6-digit code
  channel TEXT NOT NULL,               -- 'email' in v0
  expiresAt INTEGER NOT NULL,
  consumedAt INTEGER,                  -- set once verified
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (identifier, createdAt)
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  parentRegionId TEXT,
  defaultEmergencyNumber TEXT NOT NULL,
  defaultLanguage TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

INSERT OR IGNORE INTO regions (id, name, country, parentRegionId, defaultEmergencyNumber, defaultLanguage, createdAt) VALUES
  ('jp', 'Japan', 'JP', NULL, '110', 'ja-JP', 0),
  ('jp-47', 'Okinawa Prefecture', 'JP', 'jp', '110', 'ja-JP', 0),
  ('us', 'United States', 'US', NULL, '911', 'en-US', 0),
  ('gb', 'United Kingdom', 'GB', NULL, '999', 'en-GB', 0);

-- A pending guardian (support contact) invite. Becomes a contact + endpoint once
-- the guardian accepts and verifies a reach channel.
CREATE TABLE IF NOT EXISTS guardian_invites (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  guardianName TEXT,
  guardianPhone TEXT,
  guardianEmail TEXT,
  relationship TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  createdAt INTEGER NOT NULL,
  acceptedAt INTEGER
);

-- Link events + contacts to a user. Nullable + additive so pilot rows (keyed by
-- userHash) are untouched; sign-up claims them by setting userId where userHash
-- matches.
ALTER TABLE events ADD COLUMN userId TEXT;
ALTER TABLE contacts ADD COLUMN userId TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_guardian_invites_user ON guardian_invites (userId);
CREATE INDEX IF NOT EXISTS idx_contacts_userid ON contacts (userId);
CREATE INDEX IF NOT EXISTS idx_events_userid ON events (userId);
