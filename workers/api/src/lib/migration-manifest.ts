/**
 * The migration set THIS build of the Worker was written against (Brief 33c §3 — deploy
 * / migration state, live vs pending).
 *
 * The Worker cannot enumerate migrations/*.sql at runtime: those files are never bundled,
 * and there is no filesystem in the Workers runtime. So the health panel compares what the
 * DATABASE reports applied (d1_migrations) against this list, and anything in the list the
 * database has not applied is PENDING — which is precisely the state that has bitten this
 * project before (deploy the code, forget the migration, discover it in production).
 *
 * Hand-maintained by necessity, but NOT by trust: console-boundary.guard.test.ts reads the
 * migrations directory and fails if this array and that directory disagree. Adding a
 * migration without adding it here is a red test, not a silent drift.
 */
export const MIGRATIONS_AT_BUILD: readonly string[] = [
  '0001_init',
  '0002_contacts',
  '0003_locale',
  '0004_contact_endpoints',
  '0005_identity',
  '0006_contacts_nullable_userhash',
  '0007_lifecycle_delivery',
  '0008_custody_integrity',
  '0009_coordinator',
  '0010_guardian_channel',
  '0011_event_origin',
  '0012_roles_model',
  '0013_checkin',
  '0014_closure_v0',
  '0015_cascade',
  '0016_password',
  '0017_one_active_event_and_relink',
  '0018_cascade_10s_default',
  '0019_line_pairing',
  '0020_closure_lockout',
  '0021_tampering',
  '0022_closure_timeout',
  '0023_password_reset',
  '0024_dual_consent',
  '0025_escalation',
  '0026_feed_loss',
  '0027_one_active_per_account',
  '0028_checkin_contact',
  '0029_accounts_passwordless',
  '0030_contact_consent',
  '0031_org_tenancy',
  '0032_incident_tally',
  '0033_org_registration',
  '0034_zk_custody',
  '0035_recovery_key',
  '0036_case_files',
  '0037_intake_stats_rate',
  '0038_entitlement',
  '0039_redeem_rate',
  '0040_entitlement_grandfather',
  '0041_enrollment_codes_consumer',
  '0042_platform_role',
  '0043_grant_operator',
  '0044_sole_operator',
  '0045_checkin_primary_only',
  '0046_canary_isolation',
  '0047_encryption_state',
  '0048_integrity_serialization',
  '0049_capture_completeness',
  '0050_backfill_completeness',
  '0051_vault_scan_cursor',
  '0052_seal_on_close',
  '0053_consumed_capabilities',
  '0054_device_credentials',
  '0055_outbound_attempts',
];
