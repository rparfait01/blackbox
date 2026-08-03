-- Brief 35 Fix B §D — THE OPERATOR ALERT CHANNEL.
--
-- Every brief from 33 onward has specified error-level alerts with no defined destination. They
-- fire into logs nobody watches. An alert nobody receives is not an alert — the same class as a
-- verdict with no code path that produces it (Brief 37 Fix A).
--
-- WHY A TABLE. §D requires alerts be rate-limited but NEVER dropped: a storm collapses to a count
-- plus the first and last instance. In-isolate buffering cannot do that, because a storm arrives
-- across many isolates and each would send its own "first". This table is the shared window, and
-- the cron drains closed windows so a suppressed burst is always eventually reported.
--
-- SILENCE MUST MEAN NOTHING HAPPENED. That is the property being bought: an operator who receives
-- nothing may conclude nothing fired, and that conclusion has to be sound.
CREATE TABLE IF NOT EXISTS operator_alerts (
  alertType   TEXT NOT NULL,
  windowStart INTEGER NOT NULL,
  firstAt     INTEGER NOT NULL,
  lastAt      INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  firstDetail TEXT,
  lastDetail  TEXT,
  -- When the immediate (first-of-window) notification was sent.
  notifiedAt  INTEGER,
  -- When the end-of-window summary was sent. NULL with count > 1 means a summary is still owed.
  summarisedAt INTEGER,
  PRIMARY KEY (alertType, windowStart)
);

CREATE INDEX IF NOT EXISTS idx_operator_alerts_owed ON operator_alerts (summarisedAt, windowStart);
