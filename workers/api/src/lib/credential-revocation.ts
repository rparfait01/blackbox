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
 * ═══ WHAT IS NOT HERE, AND WHY ═══════════════════════════════════════════════════════════════
 *
 * `enrollment_codes` is a RECORD and is never deleted, at any age. A redemption row is the only
 * evidence of who was enrolled and by whom, which is precisely what an institutional audit asks
 * for. Its USABILITY is already swept and always was: `claimEnrollmentCode` advances usedCount in
 * one atomic statement guarded by `revoked = 0 AND usedCount < maxUses AND (expiresAt IS NULL OR
 * expiresAt > now)`, so a spent or expired code cannot authorise anything while its row survives
 * forever. That is the correct shape for every row in this file's blast radius, and the reason
 * this one is excluded rather than tuned.
 *
 * `integrity_idempotency` is not here either. It is chain-append deduplication, and a wrong
 * age-out double-appends a chain entry — a custody defect far worse than the rows it would save.
 *
 * EVERY table here is a CREDENTIAL store. None of them is a record of what happened — that
 * distinction is the whole design, and it is why `audit_log`, `delivery_records`,
 * `closure_reports`, `chunks_index`, `integrity_records` and `events` appear nowhere in this
 * function and must never be added to it.
 */
/**
 * ═══ EVERY SWEPT TABLE STATES WHY IT IS A CREDENTIAL AND NOT A RECORD. ═══════════════════════
 *
 * The standing rule: when classifying data, the DEFAULT IS RECORD. The two errors are not equal —
 * keeping a dead credential costs a row; deleting a record destroys proof that cannot be
 * recreated. That line was drawn toward deletion twice in one week (enrollment codes, then
 * connected LINE pairings), both times by me, both times plausibly.
 *
 * So a table cannot be swept on someone's judgement in the moment. It has to be argued here, in
 * writing, and the guard fails a sweep that names a table with no entry in this table.
 */
export const SWEEP_JUSTIFICATIONS: Record<string, string> = {
  otp_codes:
    'A one-time login code. After expiry it authorises nothing and proves nothing: the LOGIN it ' +
    'authorised is recorded in audit_log, which is the record. This row is the key, not the door.',
  password_resets:
    'A reset token. Same shape: the reset itself is audited; this row only lets someone perform ' +
    'one, and after expiry it cannot.',
  webauthn_challenges:
    'A nonce held for the duration of one WebAuthn ceremony. It has no meaning outside that ' +
    'exchange and identifies nobody afterwards — the CREDENTIAL it registered lives in ' +
    'webauthn_credentials, which is never swept.',
  account_magic_links:
    'A sign-in link. The sign-in is audited; the link is the mechanism. Expired, it is inert.',
  consumed_capabilities:
    'REPLAY PREVENTION, and the one row here that is a live safety control rather than a ' +
    'leftover. Safe to delete ONLY after the capability could no longer be replayed anyway — ' +
    'see REPLAY_SAFE, which asserts the retention outlives CAPABILITY_TTL_MS.',
  line_pairings:
    'ONLY rows that were never connected. An unscanned nonce is a credential that expired unused. ' +
    'A CONNECTED pairing is a RECORD — proof of who connected a LINE contact and when — and is ' +
    'excluded by the WHERE clause. The first version of this sweep did not make that distinction.',
};

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
  // ═══ A CONNECTED PAIRING IS A RECORD. ONLY AN UNUSED ONE IS A CREDENTIAL. ═════════════════
  //
  // CORRECTION to what this function shipped as. It deleted every expired row, and a CONNECTED
  // pairing is expired too — `expiresAt` was stamped when the nonce was minted and is long past
  // by the time anyone scans it. So the sweep would have destroyed the record of who connected a
  // LINE contact and when, which is the same shape as an enrollment redemption: proof of who was
  // enrolled and by whom. Delivery itself was never at risk — `redeemPairing` writes the live
  // address into `contact_endpoints` via upsertSlot — but the enrollment record was.
  //
  // So only pairings that were NEVER connected are swept: an unscanned nonce is a credential that
  // can no longer authorise anything, and nothing else.
  await run(
    'line_pairings',
    "DELETE FROM line_pairings WHERE status != 'connected' AND connectedAt IS NULL AND expiresAt IS NOT NULL AND expiresAt < ?",
    cutoff,
  );
  return counts;
}
