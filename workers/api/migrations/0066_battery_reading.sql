-- Brief 59 — BATTERY AT TRIGGER AND AT CLOSE. Two numbers per event, nothing else.
--
-- A survivor reported her phone at 10-11% with an alert running, and I could not tell her what an
-- active event costs because nothing measures it. I refused to invent a figure; this is the
-- instrument that replaces the guess.
--
-- ═══ WHY TWO READINGS AND NOT A SERIES ═══════════════════════════════════════════════════════
--
-- A poll would be a second recurring timer on the alert path, and this session has spent a week
-- on what recurring timers cost when nobody is watching them. Two readings and the event duration
-- give a rate, which is the whole question. A series would give a curve nobody has asked for at
-- the price of a loop somebody has to bound.
--
-- ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════════════════════
--
-- Not a fingerprint. `navigator.getBattery()` needs no permission and is coarse, and only the
-- LEVEL and the charging flag are stored — never the discharging/charging TIME estimates, which
-- are the high-entropy fields the fingerprinting literature is actually about, and which we have
-- no use for.
--
-- NULL is the normal case, not a failure: Firefox and every iOS browser do not implement the API
-- at all. A null here means "not reported", never "0%".
ALTER TABLE events ADD COLUMN batteryAtTrigger REAL;
ALTER TABLE events ADD COLUMN batteryAtClose REAL;
ALTER TABLE events ADD COLUMN batteryChargingAtTrigger INTEGER;
