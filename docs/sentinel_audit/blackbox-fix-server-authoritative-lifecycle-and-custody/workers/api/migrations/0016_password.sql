-- BLACK BOX backend schema v16 (Brief 14). Remove email from the auth critical
-- path. Accounts now carry a password (PBKDF2 hash, same format as the lock/duress
-- codes), so signup and login never depend on an outbound email succeeding.
--
-- Legacy accounts created under the email-OTP flow have no password; login falls
-- back to verifying the existing closure-pin hash (lockCodeHash) for them, so a
-- previously-good account can still sign in.

ALTER TABLE users ADD COLUMN passwordHash TEXT;
