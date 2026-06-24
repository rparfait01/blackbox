-- BLACK BOX backend schema v21 (Fix Brief 15 §E3/§E4). Repetition→tampering.
-- When repeated UNSAT (duress) closure signals arrive within the configured
-- window, the event's disposition escalates to TAMPERING. tamperingAt is the
-- write-once timestamp of that escalation; its presence is the server-truth flag
-- that a coordinator may not clean-close the event without an explicit, logged
-- override. Additive + nullable so existing rows are untouched.
ALTER TABLE events ADD COLUMN tamperingAt INTEGER;
