-- BLACK BOX backend schema v3 (W7). The event carries the user's locale so the
-- contact dashboard's CALL EMERGENCY button can show the right local number
-- (Japan: 110 police / 119 ambulance). Nullable, additive — existing rows are
-- untouched and default to the Japan pilot numbers at read time.

ALTER TABLE events ADD COLUMN locale TEXT;
