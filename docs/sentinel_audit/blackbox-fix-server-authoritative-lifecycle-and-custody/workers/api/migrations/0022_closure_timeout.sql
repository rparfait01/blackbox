-- BLACK BOX backend schema v22 (Fix Brief 15 §E5). Awaiting-confirmation
-- timeout fallback. When a CLEAN (sat) closure request sits unconfirmed, a
-- scheduled job re-prompts support at 60s and advances the confirmation tier at
-- 180s. These write-once timestamps guard each step so it fires exactly once.
-- Additive + nullable; existing rows untouched.
ALTER TABLE events ADD COLUMN closureRepromptAt INTEGER;
ALTER TABLE events ADD COLUMN closureAdvancedAt INTEGER;
