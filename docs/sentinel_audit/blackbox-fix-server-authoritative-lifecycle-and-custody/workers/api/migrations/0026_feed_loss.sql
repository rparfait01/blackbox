-- BLACK BOX backend schema v26 (Fix Brief 16 §3 — feed-loss closure). Once
-- emergency services have been notified, the live feed is the remaining value;
-- when the feed physically stops (device dark / stream lost) the session closes
-- with a mandatory note that closure is NOT an indication of safety. feedLostAt
-- is the write-once moment of that feed-loss close, recorded distinctly from a
-- consented SAT close. Additive + nullable.
ALTER TABLE events ADD COLUMN feedLostAt INTEGER;
