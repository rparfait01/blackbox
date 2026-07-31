/**
 * Consent scales to the parties actually ENGAGED (Brief 0B; supersedes the
 * always-dual model of Fix Brief 16 §2).
 *
 * Closure requires an assent from every party engaged with the event — never a
 * hardcoded count of two. The required-consent set is DERIVED from event state:
 *
 *  - USER assent is always required: the gesture-derived SAT/UNSAT in
 *    closeRequestStatus. A survivor never closes without their own gesture.
 *  - SUPPORT assent (supportAssentAt) is required ONLY when a support party is
 *    engaged. Dual consent is not the rule — it is the case where a responder is
 *    present. When no one is engaged, the survivor's assent alone closes.
 *
 * ENGAGED = a support party took an explicit action on THIS event: claimed the
 * coordinator role (which requires opening the link — a human is present) or
 * submitted an assent. Delivery is NOT engagement: a text delivered but never
 * opened means nobody is there, and at 3 a.m. that is the common case — treating
 * "notified" as "engaged" would leave the deadlock in place for exactly the
 * survivors who need it gone.
 *
 * Anti-coercion is preserved, not weakened: dual consent exists so a survivor
 * under duress cannot be forced to close while a responder watches — a property
 * that only has meaning WHEN a responder is actually watching, i.e. when
 * engagement exists. The instant support engages, both assents are required
 * again, with no override.
 *
 * No passive GET / refresh / link-scan is ever an assent — only an explicit
 * Request/Confirm action calls recordUserAssent / recordSupportAssent.
 *
 * The user's gesture status sets the disposition (SAT vs DURESS); a duress or
 * tampering flag survives regardless of which side initiated, and never yields a
 * clean "safe" close (§E4). A TAMPERING event will not auto-close from either the
 * solo or the dual path — it returns 'tampering_blocked' and requires a logged
 * coordinator override.
 */

import { audit } from './audit';
import { buildClosureReport } from './closure-report';
import { broadcastEventChange } from '../event-channel';
import { enqueueSeal } from './seal';
import type { Env } from '../types';

export type ConsentResult =
  | 'closed'
  | 'awaiting_user'
  | 'awaiting_support'
  | 'tampering_blocked'
  | 'already_closed'
  | 'not_found';

/** The event fields the consent model derives from. Kept minimal + plain so the
 *  decision is a PURE function, testable in isolation from D1. */
export interface ConsentState {
  status: string;
  closeRequestStatus: string | null;
  supportAssentAt: number | null;
  coordinatorClaimedAt: number | null;
  tamperingAt: number | null;
}

async function loadEvent(env: Env, eventId: string): Promise<ConsentState | null> {
  return env.DB.prepare(
    'SELECT status, closeRequestStatus, supportAssentAt, coordinatorClaimedAt, tamperingAt FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<ConsentState>();
}

export type ConsentDecision =
  | 'close_solo'
  | 'close_dual'
  | 'awaiting_user'
  | 'awaiting_support'
  | 'tampering_blocked'
  | 'already_closed';

/** A support party is ENGAGED only by an explicit action on this event: a
 *  coordinator claim (opening the link — a human is present) or a submitted
 *  assent. Delivery/notification is deliberately NOT engagement. */
export function isSupportEngaged(ev: {
  supportAssentAt: number | null;
  coordinatorClaimedAt: number | null;
}): boolean {
  return ev.coordinatorClaimedAt != null || ev.supportAssentAt != null;
}

/**
 * PURE derivation of the required-consent outcome from event state — the model,
 * with no DB and no side effects. There is deliberately NO `solo` flag or special
 * case: solo, unclaimed, and no-coordinator-online all collapse into "no support
 * engaged," and the outcome falls out of the derived party set.
 */
export function decideConsent(ev: ConsentState): ConsentDecision {
  if (ev.status === 'closed') return 'already_closed';
  // The survivor's own gesture is always required.
  if (ev.closeRequestStatus == null) return 'awaiting_user';
  const engaged = isSupportEngaged(ev);
  const supportAssent = ev.supportAssentAt != null;
  // Anti-coercion: the instant support is engaged, its assent is required too —
  // no solo close while a responder is present.
  if (engaged && !supportAssent) return 'awaiting_support';
  // TAMPERING never clean-closes from either path (§E4).
  if (ev.tamperingAt != null) return 'tampering_blocked';
  return engaged ? 'close_dual' : 'close_solo';
}

/** Record the user's assent (gesture status). Idempotent on closeRequestedAt. */
export async function recordUserAssent(
  env: Env,
  eventId: string,
  status: 'sat' | 'unsat',
  reasonSecured: string | null,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE events SET closeRequestStatus = ?, reasonSecured = ?, closeRequestedAt = ?, closeRequestDuress = ? WHERE id = ?',
  )
    .bind(status, reasonSecured, Date.now(), status === 'unsat' ? 1 : 0, eventId)
    .run();
  await audit(env, eventId, status === 'unsat' ? 'user_assent_duress' : 'user_assent', null, null);
  // §4: lifecycle is in-app — push to the open dashboard, never email.
  await broadcastEventChange(env, eventId, status === 'unsat' ? 'duress' : 'closure_request');
}

/** Record the support side's assent (coordinator/guardian). Idempotent — keeps
 *  the first assent timestamp. */
export async function recordSupportAssent(env: Env, eventId: string, by: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE events SET supportAssentAt = COALESCE(supportAssentAt, ?), supportAssentBy = COALESCE(supportAssentBy, ?) WHERE id = ?',
  )
    .bind(Date.now(), by, eventId)
    .run();
  await audit(env, eventId, 'support_assent', null, JSON.stringify({ by }));
  await broadcastEventChange(env, eventId, 'support_assent');
}

/**
 * Perform the actual close: write closed state, build the write-once report, and
 * push the in-app closure confirmation. ATOMIC and CONDITIONAL — the write is the
 * race barrier (§3). `soloGuard` re-checks, in the same UPDATE, that NO support
 * party engaged between the decision and the write: if a coordinator claimed in
 * that window the statement matches zero rows and nothing closes. Returns whether
 * this call is the one that closed the event (so the report/broadcast fire once).
 */
async function performClose(
  env: Env,
  eventId: string,
  closedBy: 'survivor_solo' | 'dual_consent',
  soloGuard: boolean,
): Promise<boolean> {
  const now = Date.now();
  // The guard fragments are constant literals (no interpolated input). `status !=
  // 'closed'` makes the dual/override close idempotent; the solo path additionally
  // requires that no responder engaged in the race window.
  const guard = soloGuard
    ? "status != 'closed' AND coordinatorClaimedAt IS NULL AND supportAssentAt IS NULL"
    : "status != 'closed'";
  const res = await env.DB.prepare(
    `UPDATE events SET status = 'closed', closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ? WHERE id = ? AND ${guard}`,
  )
    .bind(now, closedBy, now, closedBy, eventId)
    .run();
  if (res.meta.changes !== 1) return false;
  // Brief 40 §F1/§F2 — a normal close is a terminal state, so it seals. This is ONE non-
  // throwing INSERT and nothing downstream waits on it: closure is the survivor's exit from
  // a live alert, and no archival step may stand between her and it, delay it, or fail it.
  // The seal itself happens later, on the cron.
  await enqueueSeal(env, eventId, closedBy === 'survivor_solo' ? 'user_close' : 'dual_consent');
  await audit(env, eventId, closedBy === 'survivor_solo' ? 'closed_by_survivor_solo' : 'closed_by_dual_consent', null, null);
  await buildClosureReport(env, eventId);
  // §4: closure confirmation is an in-app lifecycle event — pushed live to the
  // open dashboard, NOT emailed.
  await broadcastEventChange(env, eventId, 'closed');
  return true;
}

/**
 * Evaluate the derived-consent state and close if every engaged party has
 * assented. Call this after recording either side's assent. Returns what happened:
 *  - 'closed'            all engaged parties assented (not tampering) → closed
 *  - 'awaiting_user'     support engaged; waiting on the user's gesture
 *  - 'awaiting_support'  support engaged + user assented; waiting on the coordinator
 *  - 'tampering_blocked' TAMPERING → needs a logged coordinator override
 */
export async function evaluateConsent(
  env: Env,
  eventId: string,
  _waitUntil: (p: Promise<unknown>) => void,
): Promise<ConsentResult> {
  const ev = await loadEvent(env, eventId);
  if (!ev) return 'not_found';
  const decision = decideConsent(ev);
  switch (decision) {
    case 'already_closed':
      return 'already_closed';
    case 'awaiting_user':
      return 'awaiting_user';
    case 'awaiting_support':
      return 'awaiting_support';
    case 'tampering_blocked':
      return 'tampering_blocked';
    case 'close_solo':
    case 'close_dual': {
      const closed = await performClose(
        env,
        eventId,
        decision === 'close_solo' ? 'survivor_solo' : 'dual_consent',
        decision === 'close_solo',
      );
      if (closed) return 'closed';
      // Lost the atomic race (a coordinator engaged mid-close) or already closed.
      // Re-derive from fresh state: closed is closed; otherwise dual consent now
      // applies. No window where a solo close and a claim both succeed.
      const after = await loadEvent(env, eventId);
      if (!after || after.status === 'closed') return 'already_closed';
      return 'awaiting_support';
    }
  }
}

/** Force the close after a coordinator's logged override on a TAMPERING event.
 *  Reachable only once both sides assented, so it closes on the dual path. */
export async function overrideTamperingClose(
  env: Env,
  eventId: string,
  _waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  await performClose(env, eventId, 'dual_consent', false);
}
