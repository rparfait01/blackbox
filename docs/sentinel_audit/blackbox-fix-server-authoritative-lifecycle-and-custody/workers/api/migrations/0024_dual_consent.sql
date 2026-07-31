-- BLACK BOX backend schema v24 (Fix Brief 16 §2). Symmetric, order-independent
-- dual consent. The user's assent is the existing closeRequestStatus/closeRequestedAt
-- (the gesture-derived SAT/UNSAT). The SUPPORT side's assent is recorded here.
-- Either side may assent first; the first is queued; the alert closes only when
-- BOTH assents are present. Additive + nullable; existing rows untouched.
ALTER TABLE events ADD COLUMN supportAssentAt INTEGER;
ALTER TABLE events ADD COLUMN supportAssentBy TEXT;
