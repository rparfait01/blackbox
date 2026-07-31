-- BLACK BOX backend schema v19 (Brief 18). QR-connect LINE pairing. A user can
-- never type or look up a LINE userId: they start a pairing for a contact slot,
-- show the StillPoint Official-Account deep link / QR, the contact taps it in LINE
-- and sends the one prefilled token message, and the webhook binds their captured
-- U… userId to the slot. This table holds the short-lived pending pairings.
CREATE TABLE IF NOT EXISTS line_pairings (
  nonce TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  slot TEXT NOT NULL,
  contactName TEXT,
  channelUserId TEXT,            -- captured from the webhook on connect
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'connected'
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  connectedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_line_pairings_user ON line_pairings (userId, createdAt);
