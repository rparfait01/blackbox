-- BLACK BOX backend schema v10. Contact-setup screen: the user picks a preferred
-- channel (sms / line / email) + destination when adding/editing a guardian, and
-- it is stored as the priority-1 endpoint in contact_endpoints. These columns
-- persist the user's choice on the invite row for prefill/edit.

ALTER TABLE guardian_invites ADD COLUMN preferredChannel TEXT;   -- 'sms' | 'line' | 'email'
ALTER TABLE guardian_invites ADD COLUMN channelDestination TEXT; -- phone (sms) / LINE id / email
