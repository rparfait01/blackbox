/**
 * Corrected escalation — guardian as the foundational backstop (Fix Brief 16 §3,
 * supersedes the §E5 timeout). Consent stays intact at every tier; escalation
 * only changes WHO the qualified confirmer is.
 *
 * A pending CLEAN (sat) closure request routes to the coordinator. If they do not
 * confirm:
 *   - 60s  → reprompt the COORDINATOR ONLY (in-app push to their open dashboard;
 *            never broadcast to other contacts, never email).
 *   - 180s → the coordinator path is declared FAILED: the prior coordinator claim
 *            is invalidated, the user's first assent is cleared, and the qualified
 *            confirmer escalates to the GUARDIAN tier. The user is prompted (via
 *            the status they poll) to request closure a SECOND time, which routes
 *            to the guardian; only a fresh guardian claim may confirm there.
 *
 * A DURESS or TAMPERING event never times out toward closure — responders stay
 * engaged. The guardian tier does not auto-escalate further; it is the backstop.
 * The tampering flag is NOT cleared on escalation — the guardian inherits the
 * duress/tampering disposition (escalation must not launder a flag away).
 */

import { audit } from './audit';
import { broadcastEventChange } from '../event-channel';
import { buildClosureReport } from './closure-report';
import { FEED_LOST_NOTE } from './tampering';
import type { Env } from '../types';

/** A feed is "lost" after this long dark, once emergency has been notified. */
export const FEED_LOST_MS = 90_000;

export const CLOSURE_REPROMPT_MS = 60_000;
export const CLOSURE_FAIL_MS = 180_000;

export type EscalationAction = 'none' | 'reprompt' | 'fail';

/** Pure decision for a pending clean closure on the coordinator tier. */
export function escalationAction(input: {
  status: string;
  escalationTier: string | null;
  closeRequestStatus: string | null;
  closeRequestedAt: number | null;
  tamperingAt: number | null;
  closureRepromptAt: number | null;
  coordinatorPathFailedAt: number | null;
  now: number;
}): EscalationAction {
  if (input.status !== 'active') return 'none';
  // Only the COORDINATOR tier escalates; the guardian tier is the backstop.
  if ((input.escalationTier ?? 'coordinator') !== 'coordinator') return 'none';
  if (input.closeRequestStatus !== 'sat') return 'none'; // duress/none never time out toward close
  if (input.tamperingAt != null) return 'none';
  if (input.closeRequestedAt == null) return 'none';
  if (input.coordinatorPathFailedAt != null) return 'none';
  const age = input.now - input.closeRequestedAt;
  if (age >= CLOSURE_FAIL_MS) return 'fail';
  if (age >= CLOSURE_REPROMPT_MS && input.closureRepromptAt == null) return 'reprompt';
  return 'none';
}

interface EscalationRow {
  id: string;
  status: string;
  escalationTier: string | null;
  closeRequestStatus: string | null;
  closeRequestedAt: number | null;
  tamperingAt: number | null;
  closureRepromptAt: number | null;
  coordinatorPathFailedAt: number | null;
}

/**
 * Scheduled sweep: reprompt the coordinator at 60s; declare the coordinator path
 * failed and escalate to the guardian at 180s. Each step fires once and is
 * audited. Pushes are in-app (§4) — no escalation emails.
 */
export async function runEscalation(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, escalationTier, closeRequestStatus, closeRequestedAt, tamperingAt, closureRepromptAt, coordinatorPathFailedAt FROM events WHERE status = 'active' AND closeRequestStatus = 'sat'",
  ).all<EscalationRow>();
  const now = Date.now();
  for (const row of results ?? []) {
    const action = escalationAction({ ...row, now });
    if (action === 'reprompt') {
      await env.DB.prepare('UPDATE events SET closureRepromptAt = ? WHERE id = ?').bind(now, row.id).run();
      await audit(env, row.id, 'coordinator_closure_reprompted', null, null);
      // Coordinator-only: only the coordinator's dashboard is subscribed.
      await broadcastEventChange(env, row.id, 'closure_reprompt');
    } else if (action === 'fail') {
      // Coordinator path failed: invalidate the prior claim (a fresh claim is
      // required at the guardian tier), clear the user's first assent so they must
      // request a SECOND time, and clear the coordinator's (non-)assent. Keep
      // tamperingAt — the guardian inherits the disposition.
      await env.DB.prepare(
        'UPDATE events SET coordinatorPathFailedAt = ?, escalationTier = ?, coordinatorClaimedAt = NULL, coordinatorKey = NULL, closeRequestStatus = NULL, closeRequestedAt = NULL, closeRequestDuress = 0, supportAssentAt = NULL, supportAssentBy = NULL WHERE id = ?',
      )
        .bind(now, 'guardian', row.id)
        .run();
      await audit(env, row.id, 'coordinator_path_failed', null, JSON.stringify({ afterMs: CLOSURE_FAIL_MS }));
      await audit(env, row.id, 'escalated_to_guardian', null, null);
      await broadcastEventChange(env, row.id, 'coordinator_path_failed');
    }
  }
}

/**
 * §3 feed-loss closure. Emergency services are notification-only — they have no
 * closure authority. Once they've been notified the live feed is the remaining
 * value; when the device goes dark for a sustained window the feed has physically
 * stopped, so the session closes with disposition FEED_LOST and the mandatory
 * verbatim note that closure is NOT an indication of safety. This is the ONLY
 * heartbeat-driven close, and it is explicitly distinct from a consented SAT.
 */
export async function closeFeedLostEvents(env: Env): Promise<void> {
  const cutoff = Date.now() - FEED_LOST_MS;
  const { results } = await env.DB.prepare(
    "SELECT id FROM events WHERE status = 'active' AND emergencyNotifiedAt IS NOT NULL AND feedLostAt IS NULL AND COALESCE(lastHeartbeatAt, createdAt) < ?",
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const now = Date.now();
  for (const row of results ?? []) {
    await env.DB.prepare('UPDATE events SET status = ?, closedAt = ?, closedBy = ?, feedLostAt = ? WHERE id = ?')
      .bind('closed', now, 'feed_lost', now, row.id)
      .run();
    await audit(env, row.id, 'closed_feed_lost', null, JSON.stringify({ note: FEED_LOST_NOTE }));
    await buildClosureReport(env, row.id);
    await broadcastEventChange(env, row.id, 'closed');
  }
}

/**
 * Absolute safety ceiling on how long ANY event may stay active — the ultimate
 * backstop against an orphaned/zombie event living forever (Brief 20 §2). Royce
 * tunes the value. A live DURESS/TAMPERING event is exempt from the age bound
 * (responders stay engaged; a live threat is never auto-closed by a clock).
 */
export const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;

/**
 * Pure decision (Brief 20 §2): should this active event be auto-closed as an
 * orphan? Yes when EITHER the owning account no longer exists (deleted → no one
 * can ever see or close it, so it is closed regardless of age or disposition), OR
 * it has been open past the absolute max bound. The age bound never fires on a
 * duress/tampering event — those are live threats with responders engaged.
 */
export function shouldAutoCloseOrphan(input: {
  status: string;
  createdAt: number;
  ownerMissing: boolean;
  closeRequestDuress: number | null;
  tamperingAt: number | null;
  now: number;
}): boolean {
  if (input.status !== 'active') return false;
  if (input.ownerMissing) return true;
  const engaged = input.closeRequestDuress === 1 || input.tamperingAt != null;
  if (engaged) return false;
  return input.createdAt < input.now - MAX_ACTIVE_MS;
}

/**
 * Scheduled orphan safeguard (Brief 20 §2). Closes any active event that can no
 * longer be seen or closed by its owner — a deleted account, or an event open past
 * the absolute safety ceiling — with the mandatory feed-loss note so it stops
 * emitting notifications and is auditable. A closed event fires nothing further.
 * This is defense-in-depth: §1 blocks sign-out/delete during a live alert, so new
 * orphans should not form; this catches any that slip through or predate the lock.
 */
export async function closeOrphanedEvents(env: Env): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.status, e.createdAt, e.closeRequestDuress, e.tamperingAt,
            CASE WHEN e.userId IS NOT NULL AND u.id IS NULL THEN 1 ELSE 0 END AS ownerMissing
       FROM events e LEFT JOIN users u ON u.id = e.userId
      WHERE e.status = 'active'`,
  ).all<{
    id: string;
    status: string;
    createdAt: number;
    closeRequestDuress: number | null;
    tamperingAt: number | null;
    ownerMissing: number;
  }>();
  for (const row of results ?? []) {
    if (!shouldAutoCloseOrphan({ ...row, ownerMissing: row.ownerMissing === 1, now })) {
      continue;
    }
    await env.DB.prepare(
      'UPDATE events SET status = ?, closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ?, reasonSecured = ? WHERE id = ? AND status = ?',
    )
      .bind('closed', now, 'orphan_auto_close', now, 'system', FEED_LOST_NOTE, row.id, 'active')
      .run();
    await audit(env, row.id, 'closed_orphan', null, JSON.stringify({ note: FEED_LOST_NOTE, ownerMissing: row.ownerMissing === 1 }));
    await buildClosureReport(env, row.id);
    await broadcastEventChange(env, row.id, 'closed');
  }
}
