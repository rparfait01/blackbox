-- BLACK BOX backend schema v4 — the spine correction.
--
-- BLACK BOX is the system; LINE/SMS/email/push are interchangeable channels. A
-- contact is a PERSON, who has one or more reach endpoints tried in priority
-- order until one succeeds. This replaces the v2 model where a contact had a
-- single hardwired channel + channelUserId.

CREATE TABLE IF NOT EXISTS contact_endpoints (
  id TEXT PRIMARY KEY,             -- UUID / random hex
  contactId TEXT NOT NULL,         -- FK to contacts.id
  channel TEXT NOT NULL,           -- 'push' | 'line' | 'telegram' | 'sms' | 'email'
  channelIdentifier TEXT NOT NULL, -- the address on that channel (LINE userId, phone, etc.)
  priority INTEGER NOT NULL,       -- lower = tried first
  verifiedAt INTEGER,              -- nullable; set once the endpoint is confirmed reachable
  createdAt INTEGER NOT NULL
);

-- Preserve existing data: each existing contact's single (channel, channelUserId)
-- becomes one endpoint at priority 1. Must run BEFORE the columns are dropped.
INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt)
  SELECT lower(hex(randomblob(16))), id, channel, channelUserId, 1, NULL, createdAt
  FROM contacts;

-- The index on contacts.channel must go before the column it references.
DROP INDEX IF EXISTS idx_contacts_channel;

-- A contact is now just a person; channels live in contact_endpoints.
ALTER TABLE contacts DROP COLUMN channelUserId;
ALTER TABLE contacts DROP COLUMN channel;

CREATE INDEX IF NOT EXISTS idx_endpoints_contact ON contact_endpoints (contactId, priority);
