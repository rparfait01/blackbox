/**
 * Brief 37 §E / Brief 40 §E — THE OWNER-CONSENTED PURGE, as a code path rather than an operation.
 *
 * WHY THIS EXISTS. `PURGED_BY_CONSENT` is the verdict that reconciles two commitments the product
 * makes at once: sealed evidence is retained for 36 months under a lock that binds the OPERATOR,
 * and the incident record belongs to the user, who may have it destroyed. Brief 40 §0 rests
 * entirely on that reconciliation.
 *
 * But nothing in this product could produce it. `verifyChain` READ an audit row with action
 * `chunks.purged_owner_consent`, and no code path anywhere WROTE one. The five production events
 * carry that verdict only because the row was inserted operationally at 13c539f. So the outcome
 * that the retention story depends on was reachable exactly once, by hand, and never again — a
 * documented guarantee with no mechanism behind it.
 *
 * ── WHAT IT DESTROYS, AND WHAT IT MUST NOT ────────────────────────────────────────────────────
 *
 *   blackbox-media   capture chunks for THIS event. Deleted. This is the survivor's recording and
 *                    she is entitled to have it gone.
 *   blackbox-vault   sealed manifests. NEVER TOUCHED. Locked for 1096 days under a rule that
 *                    binds the operator, and a sweep that reached it would fail partway through
 *                    having already deleted what was not protected (Brief 40 §E).
 *
 * The chain records also survive. That is the point of the verdict: the record that an incident
 * occurred, and what it attested to, remains provable; the content is gone. Destroying the chain
 * as well would leave no way to demonstrate that the destruction was consented rather than
 * tampering — which is the accusation this whole custody layer exists to answer.
 *
 * ── WHY IT IS REFUSED DURING A LIVE ALERT ─────────────────────────────────────────────────────
 *
 * The threat model is an aggressor holding an unlocked phone. Mid-event, "delete my recordings"
 * is exactly what he would press. Consent given under duress is not consent, and the same
 * reasoning already blocks settings changes, sign-out and recovery-code re-issue during an alert
 * (Brief 20). After the event is closed the owner can purge freely.
 */
import { audit } from './audit';
import type { Env } from '../types';

export interface ConsentedPurgeResult {
  ok: boolean;
  reason?: 'not_found' | 'not_owner' | 'locked_during_active_alert' | 'already_purged';
  chunks: number;
  objects: number;
  restorePoint: string | null;
  dryRun: boolean;
}

/** What a caller must present to prove this is the owner asking. */
export interface ConsentedPurgeInput {
  eventId: string;
  /** The requesting account, from an authenticated session — never from the body. */
  userId: string;
  /** The account's device hash, for events predating the userId backfill (migration 0005). */
  userHash?: string | null;
  confirm: boolean;
  /** D1 bookmark or equivalent, recorded in the audit row so the destruction is reversible-in-principle. */
  restorePoint?: string | null;
}

export async function purgeCaptureOnConsent(env: Env, input: ConsentedPurgeInput): Promise<ConsentedPurgeResult> {
  const empty = { chunks: 0, objects: 0, restorePoint: null, dryRun: !input.confirm };

  const event = await env.DB.prepare('SELECT id, userId, userHash, status FROM events WHERE id = ?')
    .bind(input.eventId)
    .first<{ id: string; userId: string | null; userHash: string; status: string }>();
  if (!event) return { ok: false, reason: 'not_found', ...empty };

  // OWNERSHIP, checked server-side against the SESSION's account. The identifier never arrives in
  // the body — it is a lookup key and never an authorization (Brief 30 Fix A; Brief 2 Fix A §C1).
  // Matched on userId, falling back to userHash for events predating the 0005 backfill, which is
  // the same pairing the single-active resolver uses.
  const owns = event.userId
    ? event.userId === input.userId
    : !!input.userHash && event.userHash === input.userHash;
  if (!owns) return { ok: false, reason: 'not_owner', ...empty };

  // Duress. See the header — mid-event this is the aggressor's button.
  if (event.status === 'active') return { ok: false, reason: 'locked_during_active_alert', ...empty };

  const existing = await env.DB.prepare(
    "SELECT 1 AS present FROM audit_log WHERE eventId = ? AND action = 'chunks.purged_owner_consent' LIMIT 1",
  )
    .bind(input.eventId)
    .first<{ present: number }>();
  if (existing?.present === 1) return { ok: false, reason: 'already_purged', ...empty };

  const { results } = await env.DB.prepare('SELECT r2Key FROM chunks_index WHERE eventId = ? ORDER BY sequence ASC')
    .bind(input.eventId)
    .all<{ r2Key: string }>();
  const keys = (results ?? []).map((r) => r.r2Key);

  if (!input.confirm) {
    // DRY RUN runs the same enumeration the deletion runs, so the number previewed is the number
    // that would go — not a separate estimate that could disagree with it.
    return { ok: true, chunks: keys.length, objects: keys.length, restorePoint: null, dryRun: true };
  }

  let deleted = 0;
  for (const key of keys) {
    // MEDIA only. Never env.VAULT — see the header.
    await env.MEDIA.delete(key);
    deleted += 1;
  }
  await env.DB.prepare('DELETE FROM chunks_index WHERE eventId = ?').bind(input.eventId).run();

  const restorePoint = input.restorePoint ?? null;
  // THE ROW THE VERDICT READS. Without this the purge is indistinguishable from tampering, and
  // verifyChain would report INCOMPLETE or BROKEN about a destruction the owner asked for.
  await audit(env, input.eventId, 'chunks.purged_owner_consent', input.userId, {
    chunks: deleted,
    restorePoint,
  });

  return { ok: true, chunks: deleted, objects: deleted, restorePoint, dryRun: false };
}
