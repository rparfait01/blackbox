-- BLACK BOX backend schema v14 (Brief 9 Phase D/E). v0 closure model: the user
-- REQUESTS closure (sending only a SAT/UNSAT status — the 3-digit pin is
-- evaluated on-device and never transmitted), and the COORDINATOR secures it.
-- The user can never self-close.

ALTER TABLE events ADD COLUMN closeRequestStatus TEXT;  -- 'sat' | 'unsat' (duress) | NULL
ALTER TABLE events ADD COLUMN reasonSecured TEXT;       -- user's concise "why secure" entry
ALTER TABLE events ADD COLUMN reasonTriggered TEXT;     -- entered post-event (why it triggered)
ALTER TABLE events ADD COLUMN securedAt INTEGER;        -- UTC ms the coordinator secured
ALTER TABLE events ADD COLUMN securedBy TEXT;           -- 'coordinator'
ALTER TABLE events ADD COLUMN failedPinAttempts INTEGER NOT NULL DEFAULT 0;

-- Write-once closure status report (the LT7 item). One per secured event.
CREATE TABLE IF NOT EXISTS closure_reports (
  eventId TEXT PRIMARY KEY,
  reportJson TEXT NOT NULL,       -- assembled snapshot (summary, origin, custody, pin, reasons)
  packageHash TEXT,               -- sha256 of the report JSON
  createdAt INTEGER NOT NULL,
  tzOffsetMinutes INTEGER
);
