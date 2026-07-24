-- BLACK BOX backend schema v39 — code-redemption rate limit (Brief 28 §4).
--
-- Readable codes (Brief 28 §4) are shorter than the old 128-bit hex, so redemption of
-- an org enrolment / activation code must not be brute-forceable. A per-ACCOUNT short
-- window (see REDEEM_WINDOW_MS / REDEEM_MAX_ATTEMPTS in lib/enrollment.ts) caps attempts
-- and 429s past the ceiling. The counter lives on the account, like the tally + intake
-- spam floors; a successful redeem stops the attacker anyway. Additive + nullable.
ALTER TABLE users ADD COLUMN redeemWindowStart INTEGER;
ALTER TABLE users ADD COLUMN redeemAttempts INTEGER NOT NULL DEFAULT 0;
