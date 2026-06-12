-- BLACK BOX backend schema v15 (Brief 11 Phase C). Sequential contact cascade:
-- contacts notified in priority order, staggered (default 15s apart), guardian
-- last. Halts once a coordinator is claimed; escalates to the emergency-services
-- fallback if the chain completes unclaimed.

ALTER TABLE users ADD COLUMN cascadeIntervalSeconds INTEGER NOT NULL DEFAULT 15;
ALTER TABLE users ADD COLUMN emergencyAfterSeconds INTEGER NOT NULL DEFAULT 120;

-- cascadeStep = how many steps have fired; the atomic CAS on this column keeps
-- the in-request stagger and the cron backstop from double-notifying.
ALTER TABLE events ADD COLUMN cascadeStep INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN emergencyNotifiedAt INTEGER;
