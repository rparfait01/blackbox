-- BLACK BOX backend schema v18 (Brief 17). The cascade interval default is now
-- 10s (was 15s) so the full primary->secondary->tertiary->guardian->emergency
-- chain lands inside 60s at T+0/+10/+20/+30/+40, and emergency is now the final
-- cascade STEP (fired at its window if unclaimed) rather than a separate 120s
-- fallback. SQLite cannot alter a column default in place, so the durable default
-- lives in createDraftUser (explicit 10) + this one-time backfill of all rows.

UPDATE users SET cascadeIntervalSeconds = 10;
