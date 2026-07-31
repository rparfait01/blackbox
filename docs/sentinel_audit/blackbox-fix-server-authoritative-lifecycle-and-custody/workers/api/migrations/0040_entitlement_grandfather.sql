-- BLACK BOX backend schema v40 — grandfather existing accounts (Brief 28 fix).
--
-- 0038 added `entitlement` with DEFAULT 'unactivated', which silently flipped EVERY
-- existing pilot account to un-armable (armable folds entitlement in Brief 28 §2). That
-- is a protection regression: a survivor who was Armed before the migration would drop
-- to "Not activated" and could no longer arm — including Dominick. The trigger still
-- fired (§0 keeps that ungated), but the armed affordance was silently lost.
--
-- Existing accounts were never asked to activate, so they are grandfathered here to
-- 'activated' (source operator_grant — the system granting the pilot population access),
-- activated as of their creation time. This runs ONCE against the current population.
-- Accounts created AFTER this migration start 'unactivated' via the 0038 column default
-- (the paywall applies to NEW users only), so the acceptance suite's fresh signups —
-- which expect 'unactivated' — are unaffected.
UPDATE users
   SET entitlement = 'activated',
       entitlement_source = 'operator_grant',
       activatedAt = COALESCE(activatedAt, createdAt)
 WHERE entitlement = 'unactivated';
