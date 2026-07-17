-- BLACK BOX backend schema v29 (Accounts §1/§2 — passwordless identity).
--
-- Identity only. No payment, no billing, no org model (Tenancy owns those).
--
-- Passwordless auth rests on three stores, all ADDITIVE. Nothing here touches the
-- `users` columns that USER_COLS selects or that session verification reads, so
-- every existing pilot session keeps verifying unchanged — accounts layer ON TOP.
--
-- Threat model note (why none of this is email-based): the survivor's abuser may
-- monitor the inbox. A passkey lives in the device keychain and cannot be phished
-- out of an inbox; a recovery code is held by the survivor (or their org), never
-- sent. The magic link exists ONLY as the no-passkey-device fallback and the pilot
-- migration path, and is REFUSED once the account has a passkey (see
-- account_magic_links) — so email is never a standing login path for a
-- passkey-enrolled account.

-- Passkeys (WebAuthn). One row per enrolled authenticator; a user may have several
-- (phone, laptop, hardware key). publicKey is the COSE key, base64url. counter is
-- the signature counter for clone detection. No secret material lives here — a
-- public key is useless to an attacker who reads this table.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credentialId TEXT PRIMARY KEY,     -- base64url credential id from the authenticator
  userId TEXT NOT NULL,
  publicKey TEXT NOT NULL,           -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                   -- JSON array, e.g. ["internal","hybrid"]
  deviceLabel TEXT,                  -- human hint for the self-view ("iPhone")
  createdAt INTEGER NOT NULL,
  lastUsedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials (userId, createdAt);

-- In-flight WebAuthn ceremonies. A challenge is single-use and short-lived; it is
-- deleted on verify. userId is NULL for a login ceremony started before the user is
-- known (usernameless/discoverable credential).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,        -- base64url random
  userId TEXT,                       -- NULL for a discoverable-credential login
  kind TEXT NOT NULL,                -- 'register' | 'login'
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges (expiresAt);

-- Account magic links — the no-passkey fallback ONLY. Modeled directly on
-- password_resets (0023): the token is random, STORED AS A HASH, single-use and
-- time-boxed. Deliberately NOT a stateless HMAC like lib/magic-link.ts's
-- event-scoped tokens — a stateless account-login token would be replayable for its
-- whole TTL, and it would entangle MAGIC_LINK_SECRET (which is event-scoped, and
-- which sessionSecret() falls back to) with account auth. A distinct, consumable
-- store keeps the two blast radii separate.
CREATE TABLE IF NOT EXISTS account_magic_links (
  tokenHash TEXT PRIMARY KEY,        -- sha256(token); the token itself only ever lives in the email
  userId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  consumedAt INTEGER,                -- set once redeemed; single-use
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_magic_links_user ON account_magic_links (userId, createdAt);

-- Recovery codes — the discreet backup to keychain auto-restore (§2). Generated at
-- setup, shown ONCE, stored only as a PBKDF2 hash (same self-describing format as
-- users.passwordHash, so lib/crypto verifySecret reads it directly). Single-use.
-- Never emailed: this is the path that survives a monitored inbox.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  codeHash TEXT NOT NULL,            -- pbkdf2$<iter>$<saltB64>$<hashB64>
  consumedAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (userId, consumedAt);
