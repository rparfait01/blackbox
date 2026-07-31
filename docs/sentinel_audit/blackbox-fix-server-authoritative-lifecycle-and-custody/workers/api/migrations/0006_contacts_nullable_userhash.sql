-- BLACK BOX backend schema v6 (W8A fix). Contacts can now be keyed by userId
-- (sign-up accounts) OR userHash (legacy pilot rows), so userHash must be
-- nullable. SQLite can't drop a NOT NULL in place, so rebuild the table and
-- replace the UNIQUE(userHash) index with a partial unique index that allows
-- multiple NULLs while still enforcing one contact per legacy userHash.

CREATE TABLE contacts_new (
  id TEXT PRIMARY KEY,
  userHash TEXT,                 -- nullable (legacy pilot rows only)
  userId TEXT,                   -- nullable (sign-up accounts)
  displayName TEXT NOT NULL,     -- the USER's name (alert subject)
  createdAt INTEGER NOT NULL
);

INSERT INTO contacts_new (id, userHash, userId, displayName, createdAt)
  SELECT id, userHash, userId, displayName, createdAt FROM contacts;

DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;

CREATE UNIQUE INDEX idx_contacts_userhash ON contacts (userHash) WHERE userHash IS NOT NULL;
CREATE INDEX idx_contacts_userid ON contacts (userId);
