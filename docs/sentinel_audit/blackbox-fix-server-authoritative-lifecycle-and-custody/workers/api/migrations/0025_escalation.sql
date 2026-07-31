-- BLACK BOX backend schema v25 (Fix Brief 16 §3). Corrected escalation with the
-- guardian as the foundational backstop. When the coordinator path fails to
-- confirm a pending CLEAN closure within the window, the prior coordinator claim
-- is invalidated and the qualified confirmer escalates to the guardian tier.
-- escalationTier tracks who may confirm now; coordinatorPathFailedAt is the
-- write-once moment the coordinator path was declared failed. Additive + nullable.
ALTER TABLE events ADD COLUMN escalationTier TEXT;          -- NULL/'coordinator' | 'guardian'
ALTER TABLE events ADD COLUMN coordinatorPathFailedAt INTEGER;
