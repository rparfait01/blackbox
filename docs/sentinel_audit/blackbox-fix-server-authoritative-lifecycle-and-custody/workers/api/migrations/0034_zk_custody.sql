-- BLACK BOX backend schema v34 — Zero-Knowledge Custody, Phase 1 (Brief 26).
--
-- DORMANT until the ENVELOPE_ENCRYPTION_ENABLED flag is armed. Every column and table
-- here is additive + nullable; with the flag OFF nothing reads or writes them, so the
-- capture path is byte-identical to today. Capture availability is paramount — this
-- schema exists only so the flag CAN be armed later, on test accounts, with fail-open.
--
-- The server stores only public keys, wrapped keys (each itself ciphertext under a
-- public key), hashes, and commitments. NO plaintext data key and NO private key has a
-- column here — the operator holds blobs it cannot open, by construction.

-- Survivor public key (SPKI, base64). Private half is client-custodied, never here.
ALTER TABLE users ADD COLUMN pubkey TEXT;

-- Org public key already exists (organizations.orgPubkey, reserved null in Brief 23);
-- this adds the rotation generation counter for state 8 (seat offboarding → rotate →
-- re-wrap). Full re-wrap (operator decision): no epoch hierarchy at pilot scale.
ALTER TABLE organizations ADD COLUMN orgPubkeyGeneration INTEGER NOT NULL DEFAULT 0;

-- The per-chunk wrapped data keys. One row per (capture chunk, recipient). recipientType
-- is 'survivor' | 'org' | 'recipient' (release). algId is stored per row (change #4) so a
-- future X25519 / PQ-hybrid is a config change. wrappedDek is the sealed envelope (JSON:
-- alg, ephemeral pubkey, iv, ciphertext) as text — itself ciphertext, useless server-side.
CREATE TABLE IF NOT EXISTS wrapped_keys (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  recipientType TEXT NOT NULL,        -- survivor | org | recipient
  recipientRef TEXT,                  -- userId / orgId / recipientId (the pub key holder)
  keyGeneration INTEGER NOT NULL DEFAULT 0,  -- org rotation generation this wrap targets
  algId TEXT NOT NULL,
  wrappedDek TEXT NOT NULL,           -- sealed envelope JSON; NO plaintext DEK column exists
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrapped_keys_event ON wrapped_keys (eventId, sequence);

-- Per-seat wrapped copies of the org PRIVATE key (§5 org-key delivery). N rows per org
-- per generation, one per active seat; the seat unwraps its copy with its own key. NO
-- plaintext org key column exists.
CREATE TABLE IF NOT EXISTS org_key_grants (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  seatUserId TEXT NOT NULL,
  keyGeneration INTEGER NOT NULL DEFAULT 0,
  algId TEXT NOT NULL,
  wrappedOrgPrivKey TEXT NOT NULL,    -- org private key sealed to the seat's pubkey
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_key_grants_seat ON org_key_grants (orgId, seatUserId, keyGeneration);

-- Signed PRE-ENCRYPTION plaintext commitments (change #1, admissibility). The client
-- hashes the plaintext on-device before encryption; the server stores the hash and signs
-- it into the integrity chain. This is what a later decryption is verified against.
CREATE TABLE IF NOT EXISTS plaintext_commitments (
  eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  plaintextHash TEXT NOT NULL,        -- sha256 hex of the pre-encryption plaintext
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (eventId, sequence)
);

-- Terminal marker on the chunk index (change #2, anti-truncation). A capture whose
-- final chunk never lands has no isFinal row, so a silently truncated tail is detectable.
ALTER TABLE chunks_index ADD COLUMN isFinal INTEGER NOT NULL DEFAULT 0;
