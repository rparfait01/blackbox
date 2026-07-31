-- BLACK BOX backend schema v7 (Fix Brief 1). Server-authoritative alert
-- lifecycle + observable delivery.
--
-- #3: heartbeat / lost / escalation tracking on the event. A missed heartbeat
--     ESCALATES (escalatedAt), it never auto-closes. lostAt marks the client
--     gone (pagehide beacon), distinct from a real closure.
-- #5: a per-channel delivery record for every notification attempt, so delivery
--     is observable in D1 rather than guessed.
-- #C6 (Brief 2): canonical time is UTC ms + tz offset; tzOffsetMinutes is the
--     device offset captured at open, carried for DTG/local rendering.

ALTER TABLE events ADD COLUMN tzOffsetMinutes INTEGER;   -- device tz offset at open (UTC canonical)
ALTER TABLE events ADD COLUMN lastHeartbeatAt INTEGER;   -- last heartbeat ping (UTC ms)
ALTER TABLE events ADD COLUMN lostAt INTEGER;            -- pagehide "client lost" beacon (UTC ms)
ALTER TABLE events ADD COLUMN escalatedAt INTEGER;       -- "device went dark" escalation fired once (UTC ms)

-- Per-channel delivery record. One row per endpoint ATTEMPT, in priority order.
CREATE TABLE IF NOT EXISTS delivery_records (
  id TEXT PRIMARY KEY,                 -- UUID
  eventId TEXT NOT NULL,
  messageKind TEXT NOT NULL,           -- activation | escalation | duress | closure | ...
  channel TEXT NOT NULL,               -- push | line | telegram | sms | email
  status TEXT NOT NULL,                -- delivered | failed | skipped
  providerMessageId TEXT,              -- e.g. SendGrid X-Message-Id, LINE x-line-request-id
  detail TEXT,                         -- short failure reason / status text (never PII)
  createdAt INTEGER NOT NULL,          -- UTC ms
  tzOffsetMinutes INTEGER              -- offset of the operator/server context at write
);

CREATE INDEX IF NOT EXISTS idx_delivery_event ON delivery_records (eventId, createdAt);
