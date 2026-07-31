-- BLACK BOX backend schema v28 (Brief 19 — selectable check-in recipient).
--
-- Retire the guardian-hardcoded check-in recipient (Brief 17 §1). Check-in is a
-- single-recipient heartbeat routed to a user-DESIGNATED contact. checkinContactId
-- references one row in `contacts`; NULL means "use the primary contact" (the
-- resolve default). Never the guardian. Additive + nullable, so existing accounts
-- fall through to the primary-contact default with no backfill.
ALTER TABLE users ADD COLUMN checkinContactId TEXT;
