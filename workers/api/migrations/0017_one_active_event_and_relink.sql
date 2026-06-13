-- BLACK BOX backend schema v17. Two lifecycle guarantees that close the
-- "trapped in an unclosable active event" hole (orphaned-event incident):
--
--   1) ONE ACTIVE EVENT PER USER. Triggering while one is active must RESUME the
--      existing event, never stack a second. Enforced at the data layer with a
--      partial unique index. Any pre-existing duplicate actives are deduped first
--      (keep the newest per user; older ones auto-closed) so the index can be
--      created cleanly on existing data.
--
--   2) RE-ISSUABLE COORDINATOR LINK. lastLinkIssuedAt records when the current
--      coordinator magic-link was minted, so the cron can detect an expired link
--      on an UNRESOLVED event and mint a fresh one — the path to closure
--      regenerates and never dead-ends.

-- (1a) Dedupe: auto-close older duplicate active events, keeping the newest
--      (max createdAt) per account. Mirrors the operator force-close shape so the
--      closed rows read consistently in custody/closure reporting.
UPDATE events
SET status = 'closed',
    closedAt = (strftime('%s','now') * 1000),
    closedBy = 'migration_dedupe_active',
    securedAt = (strftime('%s','now') * 1000),
    securedBy = 'system',
    reasonSecured = 'auto-closed: superseded by a newer active event (one-active-event enforcement)'
WHERE status = 'active'
  AND userId IS NOT NULL
  AND createdAt < (
    SELECT MAX(e2.createdAt) FROM events e2
    WHERE e2.userId = events.userId AND e2.status = 'active'
  );

-- (1b) One active event per account. Partial (only active rows) + userId NOT
--      NULL (anonymous userHash-only legacy events are out of scope for the
--      per-account guarantee; the create path keys resume on userId).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_event_per_user
  ON events (userId) WHERE status = 'active' AND userId IS NOT NULL;

-- (2) Coordinator-link reissue tracking (UTC ms). NULL until the first
--     coordinator notification goes out; updated every time a link is (re)minted.
ALTER TABLE events ADD COLUMN lastLinkIssuedAt INTEGER;
-- How many times the link has been re-issued after expiry (telemetry / audit).
ALTER TABLE events ADD COLUMN linkReissueCount INTEGER NOT NULL DEFAULT 0;
