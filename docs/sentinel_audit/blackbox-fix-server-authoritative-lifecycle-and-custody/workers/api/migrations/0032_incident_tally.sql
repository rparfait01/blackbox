-- BLACK BOX backend schema v32 — Anonymous Incident Tally (Brief 25).
--
-- This records THAT an incident occurred and whether it was ever officially
-- reported — NOTHING about what happened, and NOTHING about the person. It closes
-- the gap on UNREPORTED sexual assault, sexual harassment, and domestic violence:
-- official statistics only count what gets reported; this counts what doesn't.
--
-- SEVERANCE IS STRUCTURAL, NOT PROMISED (§3). This store has:
--   * NO foreign key, NO join path, NO derivation link to any account, device,
--     capture, event, session, or org. (SQLite carries no FK constraints anywhere in
--     this schema, so severance is enforced by there being no linking COLUMN at all.)
--   * NO free-text column — not optional, not hidden, not "notes." Free text is
--     re-identifying and this form has no place to type (§2).
--   * NO account id, device id, IP, session token, push token, precise timestamp, or
--     org association. Only the submission MONTH is kept — timing must never become
--     an identifier (§3).
-- It is NEVER auto-populated from a capture or event (that would be a derivation =
-- re-identification path). Fresh entry only, written solely by POST /v1/me/tally.
--
-- Every field is NULLABLE: each of the four questions is skippable ("prefer not to
-- say" is a value, and skipping entirely is NULL). regionId is a jurisdiction label,
-- not identity (region-level only, never finer) — deliberately no FK to regions.
CREATE TABLE IF NOT EXISTS incident_tally (
  id TEXT PRIMARY KEY,               -- random UUID; linked to NOTHING
  kind TEXT,                         -- sexual_assault | sexual_harassment | domestic_violence | other | prefer_not_to_say
  roughlyWhen TEXT,                  -- this_month | past_3_months | past_year | longer_ago | prefer_not_to_say
  regionId TEXT,                     -- region-level jurisdiction label; never finer, no FK
  reportedOfficial TEXT,             -- yes | no | prefer_not_to_say  (THE gap measurement)
  submissionMonth TEXT NOT NULL      -- 'YYYY-MM' only — never a precise instant
);
-- Aggregation reads group by these four; index the common grouping.
CREATE INDEX IF NOT EXISTS idx_incident_tally_agg ON incident_tally (submissionMonth, regionId, kind);

-- Rate-limit counter (§4): it lives on the ACCOUNT, and the submission NEVER
-- references the account. Limit the sender; store the record severed. tallyMonth is
-- the 'YYYY-MM' window the count applies to; a new month resets it in the handler.
-- These say only "this account submitted N tallies this month" — there is no back-
-- link from any tally row to the account.
ALTER TABLE users ADD COLUMN tallyMonth TEXT;
ALTER TABLE users ADD COLUMN tallyCount INTEGER NOT NULL DEFAULT 0;
