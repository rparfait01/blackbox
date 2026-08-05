import { audit } from './audit';
import { CAPABILITY_TTL_MS } from './signup-capability';
import type { Env } from '../types';

/**
 * BRIEF 57 — THE COORDINATOR CREDENTIAL DIES WITH THE EVENT.
 *
 * ═══ THE RULE ════════════════════════════════════════════════════════════════════════════════
 *
 * A coordinator credential exists for the duration of a live event and not one second longer.
 * Stale, unused or unneeded data is not kept unless it is critical to operations, function, or
 * evidence.
 *
 * ═══ WHAT DIES, AND WHAT MUST NEVER ══════════════════════════════════════════════════════════
 *
 * DIES: the view session (the `bbview` cookie's row) and the ability of any outstanding magic
 * token to open that event.
 *
 * NEVER: the custody chain. The audit rows. The delivery records. The closure report. The event
 * itself. Those are the evidence of what happened and who was reached, and no cleanup rule may
 * reach them at any age. Deleting a credential removes the ability to open a door. Deleting a
 * record removes the proof there was a room.
 *
 * ═══ THE ONE EXCEPTION, STATED RATHER THAN DISCOVERED ════════════════════════════════════════
 *
 * `dispatch`-role tokens SURVIVE. They are not the coordinator's session — they are minted
 * deliberately by a coordinator to hand evidence to authorities, and an authority may open one
 * hours after the alert ends. Killing them at closure would destroy an evidence handoff at
 * precisely the moment it matters, which the rule's own "critical to evidence" clause excludes.
 * Every other role — guardian, coordinator, notified — dies.
 *
 * ═══ WHY BOTH A HOOK AND A SWEEP ═════════════════════════════════════════════════════════════
 *
 * Five separate statements in this codebase move an event to a terminal state: dual consent,
 * feed-loss, the orphan safeguard, the operator force-close, and the canary purge. Wiring a hook
 * into five call sites is exactly how the sixth one gets missed — this codebase has produced that
 * defect repeatedly. So the hook runs where it can, and a cron sweep finds anything it did not,
 * including credentials created after the fact by a path nobody has written yet.
 */

export interface RevocationResult {
  /** View-session rows deleted. */
  sessions: number;
  /** True when this call was the one that recorded the revocation. */
  revoked: boolean;
}

/**
 * Revoke every access credential for one event. Idempotent, and never throws — a failure to
 * revoke must not roll back the closure it is reacting to. Closing an alert is the operation
 * that matters; tidying up after it is not allowed to interfere.
 */
export async function revokeEventCredentials(env: Env, eventId: string): Promise<RevocationResult> {
  const result: RevocationResult = { sessions: 0, revoked: false };
  try {
    const del = await env.DB.prepare('DELETE FROM coordinator_view_sessions WHERE eventId = ?')
      .bind(eventId)
      .run();
    result.sessions = del.meta?.changes ?? 0;

    const mark = await env.DB.prepare(
      'UPDATE events SET credentialsRevokedAt = ? WHERE id = ? AND credentialsRevokedAt IS NULL',
    )
      .bind(Date.now(), eventId)
      .run();
    result.revoked = (mark.meta?.changes ?? 0) > 0;

    if (result.revoked || result.sessions > 0) {
      // Audited because a credential ending is a custody fact: it bounds the window in which
      // anyone could have opened this event, which is a question an evidence review may ask.
      await audit(env, eventId, 'credentials.revoked', null, {
        sessions: result.sessions,
        firstRevocation: result.revoked,
      });
    }
  } catch {
    // Deliberately swallowed. See above.
  }
  return result;
}

/**
 * The sweep: any event that is no longer active but still holds live credentials.
 *
 * This is the backstop for the five terminal writers, and the only thing that would catch a
 * sixth. It also deletes view sessions whose event row is gone entirely — a purged canary, a
 * deleted account — which nothing else was ever going to reclaim.
 */
export async function sweepClosedEventCredentials(env: Env, limit = 200): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM events WHERE status != 'active' AND credentialsRevokedAt IS NULL LIMIT ?",
  )
    .bind(limit)
    .all<{ id: string }>();
  let n = 0;
  for (const row of results ?? []) {
    await revokeEventCredentials(env, row.id);
    n += 1;
  }
  // Orphans: a session whose event no longer exists at all.
  await env.DB.prepare(
    'DELETE FROM coordinator_view_sessions WHERE eventId NOT IN (SELECT id FROM events)',
  ).run();
  return n;
}

/**
 * How long a spent or expired single-use credential is kept before deletion.
 *
 * Not zero, and the reason is operational rather than sentimental: a support question of the form
 * "my link says it is spent, when was it used?" is answerable for this long. After that the row
 * answers nothing anybody is still asking, and it is a credential-shaped object sitting in a
 * database for no reason.
 */
export const SPENT_CREDENTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ═══ THE ONE ROW HERE THAT IS A SAFETY CONTROL, NOT A LEFTOVER ═══════════════════════════════
 *
 * `consumed_capabilities` is REPLAY PREVENTION. A signup capability is single-use, and the row is
 * what makes the second use fail — Brief 30 Fix A, where `signupId` was a live account-takeover.
 * Deleting a consumed jti while its capability is still within its own signature validity would
 * re-open that hole exactly.
 *
 * It is safe only because the retention above is far longer than the capability's life: after
 * `exp` the signature check refuses the token regardless of whether the row exists. That is a
 * DEPENDENCY between two constants in different files, so it is asserted rather than assumed —
 * see the test. If anyone raises the TTL past the retention, the test fails before the replay
 * window opens.
 */
export const REPLAY_SAFE = SPENT_CREDENTIAL_RETENTION_MS > CAPABILITY_TTL_MS * 2;

/**
 * Purge credential-shaped rows that can no longer authorise anything.
 *
 * EVERY table here is a CREDENTIAL store. None of them is a record of what happened — that
 * distinction is the whole design, and it is why `audit_log`, `delivery_records`,
 * `closure_reports`, `chunks_index`, `integrity_records` and `events` appear nowhere in this
 * function and must never be added to it.
 */
export async function purgeExpiredCredentials(env: Env, now = Date.now()): Promise<Record<string, number>> {
  const cutoff = now - SPENT_CREDENTIAL_RETENTION_MS;
  const counts: Record<string, number> = {};
  const run = async (label: string, sql: string, ...binds: unknown[]): Promise<void> => {
    try {
      const r = await env.DB.prepare(sql).bind(...binds).run();
      counts[label] = r.meta?.changes ?? 0;
    } catch {
      // A table that does not exist in this environment is not an error worth failing the sweep
      // for — the sweep's job is to remove what it can reach.
      counts[label] = -1;
    }
  };

  await run('otp_codes', 'DELETE FROM otp_codes WHERE expiresAt < ?', now);
  await run('password_resets', 'DELETE FROM password_resets WHERE expiresAt < ?', cutoff);
  await run('webauthn_challenges', 'DELETE FROM webauthn_challenges WHERE createdAt < ?', cutoff);
  await run('account_magic_links', 'DELETE FROM account_magic_links WHERE expiresAt < ?', cutoff);
  await run('consumed_capabilities', 'DELETE FROM consumed_capabilities WHERE consumedAt < ?', cutoff);
  await run('line_pairings', 'DELETE FROM line_pairings WHERE expiresAt IS NOT NULL AND expiresAt < ?', cutoff);
  return counts;
}
