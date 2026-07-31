-- BLACK BOX backend schema v30 — Contact Consent Gating (§0).
--
-- A Designated Contact now carries a CONSENT status. Until now a contact could be
-- added by a survivor and receive live emergency alerts with no record that they
-- ever agreed to the role. This closes that gap: only a `confirmed` contact is ever
-- notified (the dispatch gate lands in a later commit, after this backfill has run
-- and been verified on prod — infra first, gate last, so no live account is ever
-- cut off before it has a consent record).
--
--   pending   — added, not yet agreed. Receives ONE confirmation message, nothing else.
--   confirmed — affirmatively agreed. The only status that is ever dispatched to.
--   declined  — said no, or opted out (STOP). Never messaged again.
--
-- CONSENT IS ESTABLISHED PER CHANNEL, which is why the backfill below is not a flat
-- "everyone pending":
--   * LINE — the contact opted in BY THEIR OWN ACT: they scanned the survivor's QR
--     and messaged the BLACK BOX bot from their own device. That is affirmative,
--     contact-initiated consent, stronger than replying YES to an unsolicited text.
--     → confirmed.
--   * email — being retired as an alert channel; grandfathered confirmed here so no
--     existing account goes dark, with an in-app notice to migrate to SMS/LINE.
--     → confirmed.
--   * SMS / no endpoint — no consent basis on record. → pending; the survivor's next
--     save (or the backfill job) sends the confirmation SMS.
-- Silence is never consent: a pending contact is never auto-promoted.

ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE contacts ADD COLUMN statusUpdatedAt INTEGER;

-- Backfill: confirm a contact that has a LINE or email endpoint (its consent basis),
-- by its PREFERRED endpoint (priority 1) — the channel it was actually reached on.
-- Existing pilot contacts are single-endpoint, so this is unambiguous. Anything else
-- (an SMS-only contact, or a contact with no endpoint) stays pending.
UPDATE contacts
SET status = 'confirmed',
    statusUpdatedAt = createdAt
WHERE id IN (
  SELECT c.id
  FROM contacts c
  JOIN contact_endpoints ep
    ON ep.contactId = c.id
   AND ep.priority = (SELECT MIN(ep2.priority) FROM contact_endpoints ep2 WHERE ep2.contactId = c.id)
  WHERE ep.channel IN ('line', 'email')
);

-- Everything still pending after the backfill gets its timestamp stamped to createdAt
-- too, so statusUpdatedAt is never null for a pre-existing row.
UPDATE contacts
SET statusUpdatedAt = createdAt
WHERE statusUpdatedAt IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts (userId, status);
