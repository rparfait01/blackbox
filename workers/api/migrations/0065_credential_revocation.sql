-- Brief 57 — A COORDINATOR CREDENTIAL LIVES AS LONG AS THE EVENT, AND NOT ONE SECOND LONGER.
--
-- Magic tokens are stateless: an HMAC over (eventId, role, expiry), verified by recomputation.
-- Nothing is stored, so there is nothing to delete, and until now nothing could revoke one before
-- its one-hour expiry. A closed event's dashboard link kept working, and its view-session cookie
-- kept working for as long as the row existed.
--
-- This column is the revocation. It is set the moment an event reaches ANY terminal state, and
-- `resolveMagicCaller` refuses every non-dispatch credential for the event from that instant. One
-- integer replaces a per-token store, because the unit of revocation is the EVENT — there is no
-- case where one coordinator's link to a closed event should outlive another's.
--
-- ═══ WHAT THIS DOES NOT TOUCH, AND THE LINE MATTERS ══════════════════════════════════════════
--
-- Only the ACCESS CREDENTIAL dies. The custody chain, the audit rows, the delivery records, the
-- closure report and the event itself all stay, permanently. They are the evidence of what
-- happened and who was reached, and no cleanup rule may ever reach them. Deleting a credential
-- removes the ability to open a door; deleting a record removes the proof there was a room.
ALTER TABLE events ADD COLUMN credentialsRevokedAt INTEGER;

-- The sweep reads this constantly: closed events that still hold live credentials.
CREATE INDEX IF NOT EXISTS idx_events_credential_revocation
  ON events (status, credentialsRevokedAt);
