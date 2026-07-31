-- BLACK BOX backend schema v23 (Fix Brief 15 §D). Forgot-password.
-- A single-use, expiring reset token issued to the account email. Only the
-- SHA-256 hash of the token is stored (the token itself lives only in the email
-- link). sessionsValidFrom on users is bumped on a successful reset so every
-- session minted before the reset is rejected (old sessions invalidated).
CREATE TABLE IF NOT EXISTS password_resets (
  tokenHash TEXT PRIMARY KEY,        -- sha256(token)
  userId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,        -- UTC ms; single-use + time-boxed
  consumedAt INTEGER,                -- set once redeemed
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (userId, createdAt);

ALTER TABLE users ADD COLUMN sessionsValidFrom INTEGER;
