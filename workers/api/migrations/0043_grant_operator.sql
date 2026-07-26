-- BLACK BOX backend schema v43 — grant the operator role (Brief 33a).
--
-- Two accounts, both Royce's, both deliberate:
--   developer@blackboxsentinel.com — the surviving operator account from the Brief 32
--                                    reset; the one the console is built for.
--   royce.parfait@outlook.com      — his personal account, so he is not locked out of
--                                    operator work if the developer account is lost.
--
-- Two is the minimum that survives losing one, and the maximum that keeps the blast
-- radius small. This is matched by email rather than by id so it is readable and so it
-- is a no-op on any deployment where those accounts do not exist.
--
-- Idempotent: re-running sets the same value. It cannot promote anyone else, because the
-- WHERE names exactly two addresses.
UPDATE users
   SET platform_role = 'operator',
       updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE email IN ('developer@blackboxsentinel.com', 'royce.parfait@outlook.com');
