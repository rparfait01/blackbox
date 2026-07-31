-- BLACK BOX backend schema v13 (Brief 10). Check-in ("I'm OK") — the autonomy
-- counterpart to the alert. A voluntary, NON-emergency reassurance ping: no
-- event, no capture, no coordinator, no escalation, no location by default.

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,        -- UTC ms
  tzOffsetMinutes INTEGER,
  includeLocation INTEGER NOT NULL DEFAULT 0,
  lat REAL,                          -- only if the user opted in for THIS tap
  lon REAL
);

CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins (userId, createdAt);

-- Quick "last check-in" pointer for the reassurance line.
ALTER TABLE users ADD COLUMN lastCheckinAt INTEGER;
