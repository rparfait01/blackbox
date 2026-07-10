-- BLACK BOX backend schema v27 (Brief 15 — one OPEN event per account).
--
-- Defect: the single-active guarantee from 0017 was keyed ONLY on userId and only
-- enforced when a session token resolved one. Its partial unique index excludes
-- `userId IS NULL`, and the resume-instead-of-create check in POST /v1/events is
-- gated on `if (userId)`. So a trigger with no resolvable userId — an expired or
-- absent session token, or a legacy/covert userHash-only client — skipped the
-- resume check AND was not constrained by the index, inserting a fresh `active`
-- row with userId NULL. Concurrent active events stacked, and because
-- "account active" is "an active event exists", closing one latched the app back
-- onto the orphaned others (the ~72h zombie incident).
--
-- This adds the missing DB-level backstop for the userId-NULL class and dedupes
-- any existing duplicates first so the index builds cleanly on live data. The
-- app-level resolution (resolveSingleActive) additionally collapses events keyed
-- by userId on one trigger and userHash on another for the same account.

-- (1) Dedupe existing userId-NULL active duplicates: keep the NEWEST per userHash,
--     auto-close the older ones with the same disposition shape 0017 and the
--     operator force-close use, so custody/closure reporting reads consistently.
UPDATE events
SET status = 'closed',
    closedAt = (strftime('%s','now') * 1000),
    closedBy = 'migration_dedupe_active_userhash',
    securedAt = (strftime('%s','now') * 1000),
    securedBy = 'system',
    reasonSecured = 'auto-closed: superseded by a newer active event (one-active-event-per-account enforcement)'
WHERE status = 'active'
  AND userId IS NULL
  AND userHash IS NOT NULL AND userHash <> ''
  AND createdAt < (
    SELECT MAX(e2.createdAt) FROM events e2
    WHERE e2.userHash = events.userHash AND e2.userId IS NULL AND e2.status = 'active'
  );

-- (2) One active event per account for the TOKENLESS class: partial unique index
--     on userHash for active rows with userId IS NULL. Rows WITH a userId are
--     already covered by idx_one_active_event_per_user (0017). userHash = '' is
--     excluded — an empty device hash is not an account key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_event_per_userhash
  ON events (userHash) WHERE status = 'active' AND userId IS NULL AND userHash <> '';
