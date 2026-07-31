-- BLACK BOX backend schema v37 — Intake anonymized-export rate limit (Brief 27 §5).
--
-- The per-account monthly counter for the Destination-1 anonymized export. It lives on
-- the ACCOUNT (a spam floor), exactly like the tally's counter — the SEVERED intake_stats
-- record never references the account. Additive + nullable.
ALTER TABLE users ADD COLUMN intakeStatMonth TEXT;
ALTER TABLE users ADD COLUMN intakeStatCount INTEGER NOT NULL DEFAULT 0;
