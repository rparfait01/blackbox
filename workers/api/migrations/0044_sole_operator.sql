-- BLACK BOX backend schema v44 — ONE operator, and it is not the consumer account.
--
-- 0043 granted platform_role='operator' to royce.parfait@outlook.com on the reasoning
-- that a second operator survives losing the first. That was WRONG, and wrong in the
-- direction that matters: royce.parfait@outlook.com is a PURCHASED CONSUMER account —
-- it holds a Gumroad licence, it is entitled as purchase_web, and it is the account a
-- survivor-side user actually signs in to. Giving a consumer account cross-org platform
-- powers means one compromised consumer session reaches every organisation's data.
--
-- Operator is the ONLY role that crosses org boundaries, so it belongs on an account that
-- exists for nothing else. developer@blackboxsentinel.com is that account and is now the
-- SOLE operator.
--
-- The account itself is untouched otherwise: entitlement, contacts, passkey and licence
-- all remain, so revoking the platform role does not cost it anything it paid for. It
-- simply stops being an operator.
UPDATE users
   SET platform_role = NULL,
       updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE email = 'royce.parfait@outlook.com';

-- The sole operator's display name, as it should read in the console.
UPDATE users
   SET name = 'Developer Blackboxsentinel',
       updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE email = 'developer@blackboxsentinel.com';
