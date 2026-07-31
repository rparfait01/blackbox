-- BLACK BOX backend schema v2 (W6). Contact notification endpoints, LINE
-- delivery / closure tracking, and a pairing inbox for follow events.
--
-- Contacts are notification ENDPOINTS, not users: no account, no app install.
-- One contact per userHash in v0 (the pilot is 1:1 — Royce <-> Ikumi).

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,             -- UUID v4
  userHash TEXT NOT NULL,          -- FK to events.userHash (the user who triggers)
  channel TEXT NOT NULL,           -- 'line' (only channel in v0)
  channelUserId TEXT NOT NULL,     -- the contact's LINE user id (push target)
  displayName TEXT NOT NULL,       -- the USER's name, shown as the alert subject
  createdAt INTEGER NOT NULL
);

-- One contact per userHash in v0. The admin endpoint upserts by deleting any
-- existing rows for the userHash before inserting, so this stays 1:1.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_userhash ON contacts (userHash);

-- LINE delivery + closure state lives on the event row. Added as nullable
-- columns so the v1 -> v2 upgrade leaves existing event rows untouched.
ALTER TABLE events ADD COLUMN notifiedAt INTEGER;          -- LINE push accepted (200)
ALTER TABLE events ADD COLUMN notifyChannel TEXT;          -- 'line'
ALTER TABLE events ADD COLUMN closeRequestedAt INTEGER;    -- user submitted a pin
ALTER TABLE events ADD COLUMN closeRequestDuress INTEGER;  -- 1 if the pin was a duress pin

-- Inbox of LINE "follow" events (a person added the bot as a friend). The admin
-- reads this to learn the contact's channelUserId, then binds it to a userHash
-- via POST /v1/admin/contacts. Stored in D1 (not console logs) so the identifier
-- is available for pairing without ever being written to plaintext logs.
CREATE TABLE IF NOT EXISTS line_pairing (
  channelUserId TEXT PRIMARY KEY,
  followedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_channel ON contacts (channel);
