/**
 * Symmetric, order-independent dual consent (Fix Brief 16 §2).
 *
 * Two roles must both assent before an alert closes: the USER (the gesture-derived
 * SAT/UNSAT recorded in closeRequestStatus) and SUPPORT (the coordinator/guardian,
 * recorded in supportAssentAt). Either may act first; the first assent is QUEUED
 * and does not close; the alert closes only on the matching second assent.
 *
 * No passive GET / refresh / link-scan is ever an assent — only an explicit
 * Request/Confirm action calls recordUserAssent / recordSupportAssent.
 *
 * The user's gesture status sets the disposition (SAT vs DURESS); a duress or
 * tampering flag survives regardless of which side initiated, and never yields a
 * clean "safe" close (§E4). A TAMPERING event will not auto-close — it returns
 * 'tampering_blocked' and requires a logged coordinator override.
 */

import { audit } from './audit';
import { buildClosureReport } from './closure-report';
import { broadcastEventChange } from '../event-channel';
import type { Env } from '../types';

export type ConsentResult =
  | 'closed'
  | 'awaiting_user'
  | 'awaiting_support'
  | 'tampering_blocked'
  | 'already_closed'
  | 'not_found';

interface ConsentRow {
  userId: string | null;
  userHash: string | null;
  status: string;
  closeRequestStatus: string | null;
  supportAssentAt: number | null;
  tamperingAt: number | null;
}

async function loadEvent(env: Env, eventId: string): Promise<ConsentRow | null> {
  return env.DB.prepare(
    'SELECT userId, userHash, status, closeRequestStatus, supportAssentAt, tamperingAt FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<ConsentRow>();
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

/** Perform the actual close once both assents are confirmed: write closed state,
 *  build the write-once report, and push the in-app closure confirmation. */
async function performClose(
  env: Env,
  eventId: string,
  _event: ConsentRow,
  _waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE events SET status = ?, closedAt = ?, closedBy = ?, securedAt = ?, securedBy = ? WHERE id = ?',
  )
    .bind('closed', Date.now(), 'dual_consent', Date.now(), 'dual_consent', eventId)
    .run();
  await audit(env, eventId, 'closed_by_dual_consent', null, null);
  await buildClosureReport(env, eventId);
  // §4: closure confirmation is an in-app lifecycle event — pushed live to the
  // open dashboard, NOT emailed.
  await broadcastEventChange(env, eventId, 'closed');
}

/**
 * Evaluate dual-consent state and close if BOTH assents are present. Call this
 * after recording either side's assent. Returns what happened:
 *  - 'closed'           both assented (and not tampering) → event closed
 *  - 'awaiting_user'    support assented; waiting on the user's gesture
 *  - 'awaiting_support' user assented; waiting on the coordinator/guardian
 *  - 'tampering_blocked' both assented but TAMPERING → needs a logged override
 */
export async function evaluateConsent(
  env: Env,
  eventId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<ConsentResult> {
  const ev = await loadEvent(env, eventId);
  if (!ev) return 'not_found';
  if (ev.status === 'closed') return 'already_closed';
  const userAssent = ev.closeRequestStatus != null;
  const supportAssent = ev.supportAssentAt != null;
  if (!userAssent) return 'awaiting_user';
  if (!supportAssent) return 'awaiting_support';
  if (ev.tamperingAt != null) return 'tampering_blocked';
  await performClose(env, eventId, ev, waitUntil);
  return 'closed';
}

/** Force the close after a coordinator's logged override on a TAMPERING event. */
export async function overrideTamperingClose(
  env: Env,
  eventId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const ev = await loadEvent(env, eventId);
  if (ev && ev.status !== 'closed') {
    await performClose(env, eventId, ev, waitUntil);
  }
}
