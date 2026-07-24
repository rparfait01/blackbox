/**
 * Entitlement (Brief 28 §2) — the ONE place entitlement is granted.
 *
 * The governing rule (§0) is safety-critical: entitlement gates the ARM affordance,
 * NEVER the trigger. So this module is deliberately small and one-directional:
 *
 *   - grantEntitlement() only ever sets 'unactivated' → 'activated'. It NEVER
 *     downgrades, NEVER re-locks, NEVER expires. Once activated, permanent — an org
 *     license lapsing later cannot reach back through here to deactivate a survivor.
 *   - There is NO revokeEntitlement here. The only way back to 'unactivated' is the
 *     operator's manual, logged, fraud-only admin endpoint (§4) — never automatic,
 *     never a chargeback, never a license expiry.
 *
 * It is called from exactly four grant paths, each with its own source:
 *   org_code       — an enrollment-code redemption (bindAccountToOrg)
 *   purchase_web   — a signature-verified web-payment webhook (routes/activation.ts)
 *   purchase_ios   — an iOS in-app purchase (deferred; native app not built)
 *   operator_grant — an operator/admin manual grant (routes/admin)
 */
import { audit } from './audit';
import type { Env } from '../types';

export type EntitlementSource = 'purchase_web' | 'purchase_ios' | 'org_code' | 'operator_grant';

/**
 * Grant entitlement to an account. Idempotent and never-downgrading: an account that
 * is already 'activated' is left exactly as it is (its original source and activatedAt
 * are preserved — a later org_code redemption does not overwrite an earlier purchase).
 * Returns whether this call was the one that activated the account.
 */
export async function grantEntitlement(
  env: Env,
  userId: string,
  source: EntitlementSource,
): Promise<{ activated: boolean; alreadyActive: boolean }> {
  // Conditional UPDATE: flips to 'activated' ONLY from 'unactivated'. If the row is
  // already activated the WHERE misses and nothing changes — the first source wins,
  // permanently. This is also the no-re-lock guarantee in one statement: there is no
  // path here that writes 'unactivated'.
  const res = await env.DB.prepare(
    "UPDATE users SET entitlement = 'activated', entitlement_source = ?, activatedAt = ?, updatedAt = ? WHERE id = ? AND entitlement != 'activated'",
  )
    .bind(source, Date.now(), Date.now(), userId)
    .run();
  const activated = res.meta.changes === 1;
  if (activated) {
    await audit(env, null, 'entitlement.grant', userId, { source });
  }
  return { activated, alreadyActive: !activated };
}

/** True if the account may ARM (has activated entitlement). Read for the affordance
 *  ONLY — never call this anywhere in the trigger/capture/dispatch path. */
export async function isEntitled(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT entitlement FROM users WHERE id = ?')
    .bind(userId)
    .first<{ entitlement: string }>();
  return row?.entitlement === 'activated';
}
