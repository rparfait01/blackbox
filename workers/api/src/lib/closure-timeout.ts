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
import { revokeEventCredentials } from './credential-revocation';
import { broadcastEventChange } from '../event-channel';
import { buildClosureReport } from './closure-report';
import { renotifyContactsNoGuardian } from './notify';
import { FEED_LOST_NOTE } from './tampering';
import { declareAbnormalIfUnfinished } from './completeness';
import { enqueueSeal } from './seal';
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
  userId: string | null;
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
 * audited. Pushes are in-app (§4) — no escalation emails. workerOrigin is used by
 * the §3 no-guardian backstop to mint the dashboard link for the re-notify.
 */
export async function runEscalation(env: Env, workerOrigin: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, userId, status, escalationTier, closeRequestStatus, closeRequestedAt, tamperingAt, closureRepromptAt, coordinatorPathFailedAt FROM events WHERE status = 'active' AND closeRequestStatus = 'sat'",
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
      // ═══ P0 — THIS USED TO UN-CLAIM THE EVENT, AND THAT RE-ARMED THE CASCADE. ═══════════════
      //
      // The old statement also set `coordinatorClaimedAt = NULL` and `coordinatorKey = NULL`.
      // Measured on a live incident (93ebe889): coordinator claimed at 7.7s, survivor requested
      // closure at 88s, this branch fired at 307s — and because the cascade halt is
      // `WHERE coordinatorClaimedAt IS NULL`, the whole contact cascade RESUMED. The secondary
      // was notified at 315s and was offered TAKE COORDINATION on an event that had been
      // coordinated for five minutes. The claimable guard was correct; it was reading a column
      // this statement had just falsified.
      //
      // Escalating the CONFIRMER TIER is not the same as nobody having responded. Someone did
      // respond — they simply did not confirm a closure in time. So the claim STANDS as the
      // record that coordination was taken, `coordinatorPathFailedAt` records that the
      // coordinator's confirming authority has lapsed, and the claim route lets a fresh claim
      // through on that basis (see index.ts). The cascade stays halted, because it was halted for
      // a true reason that has not stopped being true.
      //
      // `closeRequestStatus` is still cleared: the guardian is a NEW confirmer and consent does
      // not transfer between confirmers. What changed is that the survivor can now ask again —
      // her control used to lock itself the moment she asked once (ClosureControl).
      await env.DB.prepare(
        'UPDATE events SET coordinatorPathFailedAt = ?, escalationTier = ?, closeRequestStatus = NULL, closeRequestedAt = NULL, closeRequestDuress = 0, supportAssentAt = NULL, supportAssentBy = NULL WHERE id = ?',
      )
        .bind(now, 'guardian', row.id)
        .run();
      await audit(env, row.id, 'coordinator_path_failed', null, JSON.stringify({ afterMs: CLOSURE_FAIL_MS }));
      await audit(env, row.id, 'escalated_to_guardian', null, null);
      await broadcastEventChange(env, row.id, 'coordinator_path_failed');
      // §3 (Brief 23): if there is NO guardian to escalate to, the guardian tier is
      // a dead-end. Don't let it vanish — re-notify the reachable contacts and
      // record the missing-guardian gap loudly. (Real fix: add a guardian.)
      const guardian = row.userId
        ? await env.DB.prepare("SELECT 1 AS x FROM contacts WHERE userId = ? AND role = 'guardian' LIMIT 1")
            .bind(row.userId)
            .first<{ x: number }>()
        : null;
      if (!guardian) {
        await audit(env, row.id, 'escalation_no_guardian', null, null);
        await broadcastEventChange(env, row.id, 'escalation_no_guardian');
        await renotifyContactsNoGuardian(env, row.id, workerOrigin);
      }
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
    // Brief 57 — credential dies with the event.
    await revokeEventCredentials(env, row.id);
    // Brief 38 §D — the SERVER declares this, because the device is the thing that stopped.
    // A sustained feed loss is precisely the abnormal termination this product exists for: a
    // phone seized, destroyed, or out of battery cannot report its own ending.
    await declareAbnormalIfUnfinished(env, row.id);
    // Brief 40 §F1 — the abnormal terminations matter MOST. A sustained feed loss is a phone
    // that stopped: seized, smashed, or out of battery. That capture must become a sealed
    // artifact with nobody acting, which is exactly what never happened before §F.
    await enqueueSeal(env, row.id, 'feed_lost');
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
 * A dark + UNCLAIMED event auto-closes on this shorter bound (Brief 23 §1; Royce:
 * 2h). "Dark" = no heartbeat for the bound; "unclaimed" = no coordinator ever
 * engaged. This is the zombie case that otherwise locks the user out of their own
 * account for up to MAX_ACTIVE_MS. A live-feed (recent heartbeat) or a
 * coordinator-claimed event is NEVER touched by this rule.
 */
export const DARK_UNCLAIMED_MS = 2 * 60 * 60 * 1000;

/**
 * Pure decision (Brief 20 §2 + Brief 23 §1): should this active event be
 * auto-closed as an orphan? Yes when ANY of:
 *  - the owning account no longer exists (deleted → no one can ever see/close it),
 *    regardless of age or disposition;
 *  - it is DARK (no heartbeat for DARK_UNCLAIMED_MS) AND UNCLAIMED (no coordinator
 *    ever engaged) — the zombie/lockout case;
 *  - it has been open past the absolute max bound.
 * The age/dark bounds NEVER fire on a duress/tampering event (live threats,
 * responders engaged), and NEVER on a coordinator-claimed or live-feed event.
 */
export function shouldAutoCloseOrphan(input: {
  status: string;
  createdAt: number;
  ownerMissing: boolean;
  closeRequestDuress: number | null;
  tamperingAt: number | null;
  lastHeartbeatAt: number | null;
  coordinatorClaimedAt: number | null;
  now: number;
}): boolean {
  if (input.status !== 'active') return false;
  if (input.ownerMissing) return true;
  const engaged = input.closeRequestDuress === 1 || input.tamperingAt != null;
  if (engaged) return false;
  // §1: dark + unclaimed → shorter bound. A recent heartbeat (live feed) or a
  // coordinator claim removes the event from this rule entirely.
  const lastBeat = input.lastHeartbeatAt ?? input.createdAt;
  const dark = lastBeat < input.now - DARK_UNCLAIMED_MS;
  const unclaimed = input.coordinatorClaimedAt == null;
  if (dark && unclaimed) return true;
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
            e.lastHeartbeatAt, e.coordinatorClaimedAt,
            CASE WHEN e.userId IS NOT NULL AND u.id IS NULL THEN 1 ELSE 0 END AS ownerMissing
       FROM events e LEFT JOIN users u ON u.id = e.userId
      WHERE e.status = 'active'`,
  ).all<{
    id: string;
    status: string;
    createdAt: number;
    closeRequestDuress: number | null;
    tamperingAt: number | null;
    lastHeartbeatAt: number | null;
    coordinatorClaimedAt: number | null;
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
    // Brief 57 — credential dies with the event.
    await revokeEventCredentials(env, row.id);
    // §D — same reasoning: an orphaned event never received a normal stop, so it is ABNORMAL
    // unless a terminal marker already made it COMPLETE (the call is idempotent and only
    // moves a capture out of IN_PROGRESS).
    await declareAbnormalIfUnfinished(env, row.id);
    await enqueueSeal(env, row.id, 'orphan');
    await audit(env, row.id, 'closed_orphan', null, JSON.stringify({ note: FEED_LOST_NOTE, ownerMissing: row.ownerMissing === 1 }));
    await buildClosureReport(env, row.id);
    await broadcastEventChange(env, row.id, 'closed');
  }
}
