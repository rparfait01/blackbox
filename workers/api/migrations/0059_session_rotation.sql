-- Brief 42 §C — SESSION ROTATION AT PRIVILEGE TRANSITIONS.
--
-- Sessions are stateless HMAC tokens with no server-side store, so "old identifier invalid
-- immediately" needs durable state. There is already `users.sessionsValidFrom`, a per-USER epoch
-- bumped on password reset — and it is the wrong tool here. Bumping it at a privilege transition
-- invalidates every session that account holds, on every device, which is exactly the outcome the
-- never-sign-out rule exists to prevent: a survivor signed out by a housekeeping change is a
-- survivor who cannot trigger until she remembers a credential.
--
-- So revocation is PER TOKEN. Rotating invalidates the token that was presented and nothing else.
-- A second device keeps working, because it was never the identifier being replaced.
--
-- The token itself is never stored — only its SHA-256. A revocation list that holds live session
-- tokens would be a credential store built in the name of security.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  tokenHash TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  revokedAt INTEGER NOT NULL,
  reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_revoked_sessions_user ON revoked_sessions (userId, revokedAt);

-- §C — the legacy-format share, so retiring `<userId>.<issuedAt>.<hmac>` is a decision made with
-- data rather than a guess. Sessions are stateless and cannot be enumerated, so this records the
-- format each account LAST PRESENTED. It is written only when the value changes, which for a
-- given account happens once — on the rotation that upgrades it — and therefore costs nothing on
-- the ordinary request path.
ALTER TABLE users ADD COLUMN lastSessionFormat TEXT;
