-- BLACK BOX backend schema v51 — vault scan coverage by cursor, not by cap (Brief 40 §A).
--
-- THE DEFECT. `runIntegrityScan` read `ORDER BY sealedAt ASC LIMIT 50` with no cursor, so
-- every run re-examined the SAME fifty rows. Past fifty eligible objects, coverage silently
-- became partial and stayed partial for as long as the vault kept growing — the scan reported
-- nothing wrong because it was never asked how much it had covered.
--
-- A NOTE ON DIRECTION, since it changes what the alert has to watch. The brief describes the
-- starved objects as the oldest; with `sealedAt ASC` the opposite is true — the fifty OLDEST
-- were re-verified on every run and everything NEWER was never examined at all. Same defect,
-- same severity, but the backlog grows at the new end, which is why the coverage metric below
-- counts objects whose last verification predates the current pass rather than counting age.
--
-- ONE ROW, BY CONSTRUCTION. The CHECK (id = 1) makes a second cursor unrepresentable: two
-- cursors would each believe they had covered the vault while between them missing the middle.
--
-- The cursor is what lets a BOUNDED job and FULL coverage coexist. Brief 36 §11 caps each cron
-- job at 20s precisely so a slow job cannot starve the ones behind it; the answer to "then how
-- does it ever finish" is that it does not have to finish in one run — it has to RESUME, and
-- record that it did.

CREATE TABLE IF NOT EXISTS vault_scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Last vaultKey examined in the pass currently in flight. NULL = a pass is about to start.
  -- Ordered by vaultKey (the primary key) rather than sealedAt: sealedAt can tie, and a tie
  -- makes a cursor skip or repeat rows.
  cursor TEXT,
  passNumber INTEGER NOT NULL DEFAULT 0,
  passStartedAt INTEGER,
  examinedThisPass INTEGER NOT NULL DEFAULT 0,
  verifiedThisPass INTEGER NOT NULL DEFAULT 0,
  lastPassCompletedAt INTEGER,
  lastPassExamined INTEGER,
  lastPassVerified INTEGER,
  -- Objects still unverified when a pass COMPLETED. Should be 0; anything else means the
  -- scan is not keeping up, and §A requires that be alertable rather than invisible.
  lastPassBacklog INTEGER NOT NULL DEFAULT 0,
  consecutiveBacklogPasses INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO vault_scan_state (id, cursor, passNumber) VALUES (1, NULL, 0);
