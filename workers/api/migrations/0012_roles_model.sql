-- BLACK BOX backend schema v12 (Brief 9 roles model + Brief 8 contact tabs).
-- A user has up to THREE contacts in priority order + exactly ONE guardian (the
-- zero-fail failsafe), plus a server-side guardian on/off toggle.

-- contacts gains a role + priority + the contact's own name. Existing rows become
-- the primary contact so current notification routing keeps working.
ALTER TABLE contacts ADD COLUMN role TEXT;          -- 'contact' | 'guardian'
ALTER TABLE contacts ADD COLUMN priority INTEGER;   -- 1..3 for contacts; NULL for guardian
ALTER TABLE contacts ADD COLUMN contactName TEXT;   -- the contact's OWN name (Settings tab label)
UPDATE contacts SET role = 'contact', priority = 1 WHERE role IS NULL;

-- Guardian on/off (Brief 9) — a user-controlled toggle, locked during an alert.
-- Default on. Nationality captured per the v0 user model.
ALTER TABLE users ADD COLUMN guardianEnabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN nationality TEXT;

-- One row per (user, role, priority) slot.
CREATE INDEX IF NOT EXISTS idx_contacts_user_role ON contacts (userId, role, priority);
