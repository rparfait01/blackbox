-- BLACK BOX backend schema v36 — Guided Intake case files (Brief 27).
--
-- FAIL-CLOSED by construction: a case file is a survivor's structured disclosure and must
-- NEVER be stored in plaintext. This table has NO plaintext content column — only
-- `sealedCaseFile`, the survivor-sealed envelope JSON (ciphertext under the survivor's own
-- public key, which the server does not hold). The server stores it and can open none of
-- it. Writes are additionally gated on ENVELOPE_ENCRYPTION_ENABLED at the endpoint, so
-- there is no path — client or server — that persists an unencrypted case file.
CREATE TABLE IF NOT EXISTS case_files (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,               -- the OWNING survivor; only they hold the key to open it
  sealedCaseFile TEXT NOT NULL,       -- sealed envelope JSON — ciphertext, no plaintext column exists
  taxonomyVersion TEXT NOT NULL,      -- NIBRS/WHO mapping version stamped on the record
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_files_user ON case_files (userId, createdAt);

-- Destination 1 (anonymized public stats) — a SEVERED store, modeled on incident_tally
-- (Brief 25). Strict per-submission opt-in, STRUCTURED FIELDS ONLY (no free text ever), a
-- random id, coarse month only, and NO foreign key to the case file, the account, or the
-- tally. It never joins identified data. Published only as k-anonymized aggregates.
CREATE TABLE IF NOT EXISTS intake_stats (
  id TEXT PRIMARY KEY,                -- random UUID, linked to NOTHING
  incidentTypeId TEXT,               -- closed taxonomy value only
  whenRange TEXT,                    -- coarse range
  regionId TEXT,                     -- region-level jurisdiction, never finer
  relationshipId TEXT,               -- standard category
  reportedToAuthorities TEXT,        -- yes | no | prefer_not_to_say (the gap measure)
  submissionMonth TEXT NOT NULL      -- 'YYYY-MM' only — never a precise instant
);
CREATE INDEX IF NOT EXISTS idx_intake_stats_agg ON intake_stats (submissionMonth, regionId, incidentTypeId);
