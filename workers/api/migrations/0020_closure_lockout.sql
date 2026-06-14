-- BLACK BOX backend schema v20 (Brief 19 §6). Repeated wrong closure-pin attempts
-- (3 wrong, not duress) lock the user's closure overlay AND must surface to the
-- coordinator — repeated failures can mean someone OTHER than the user is trying to
-- close. This records when that lockout fired so the coordinator's live dashboard
-- shows it. Set once (first lockout); the on-device pin is still never transmitted.
ALTER TABLE events ADD COLUMN closureLockoutAt INTEGER;
