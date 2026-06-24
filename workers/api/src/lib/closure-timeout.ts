/**
 * Awaiting-confirmation timeout fallback (Fix Brief 15 §E5).
 *
 * The dual-consent model can trap a user whose support is asleep/unreachable:
 * their CLEAN (sat) close request would otherwise hang forever. So a scheduled
 * job advances the confirmation request down the support chain on a timer.
 *
 * Royce's locked P1 policy (tunable here):
 *   - re-prompt support at 60s
 *   - advance to the next tier (→ guardian) at 180s
 *   - NO fallback to emergency services without explicit confirmation.
 *
 * Only a pending CLEAN request can trap a user. A DURESS or TAMPERING event must
 * NOT time out toward closure — responders stay engaged by design.
 */

import { audit } from './audit';
import { notifyClosureRequest } from './notify';
import type { Env } from '../types';

export const CLOSURE_REPROMPT_MS = 60_000;
export const CLOSURE_ADVANCE_MS = 180_000;

export type ClosureTimeoutAction = 'none' | 'reprompt' | 'advance';

/** Pure decision: what (if anything) a pending clean close needs right now. */
export function closureTimeoutAction(input: {
  status: string;
  closeRequestStatus: string | null;
  closeRequestedAt: number | null;
  tamperingAt: number | null;
  closureRepromptAt: number | null;
  closureAdvancedAt: number | null;
  now: number;
}): ClosureTimeoutAction {
  if (input.status !== 'active') return 'none';
  if (input.closeRequestStatus !== 'sat') return 'none'; // duress/none never time out toward close
  if (input.tamperingAt != null) return 'none';
  if (input.closeRequestedAt == null) return 'none';
  const age = input.now - input.closeRequestedAt;
  if (age >= CLOSURE_ADVANCE_MS && input.closureAdvancedAt == null) return 'advance';
  if (age >= CLOSURE_REPROMPT_MS && input.closureRepromptAt == null) return 'reprompt';
  return 'none';
}

interface TimeoutRow {
  id: string;
  status: string;
  closeRequestStatus: string | null;
  closeRequestedAt: number | null;
  tamperingAt: number | null;
  closureRepromptAt: number | null;
  closureAdvancedAt: number | null;
}

/**
 * Scheduled sweep: for every active event with a pending CLEAN close request,
 * re-prompt support at 60s and advance the confirmation tier at 180s. Each step
 * fires once (guarded by closureRepromptAt / closureAdvancedAt) and is audited.
 */
export async function advanceUnconfirmedClosures(env: Env, workerOrigin: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, closeRequestStatus, closeRequestedAt, tamperingAt, closureRepromptAt, closureAdvancedAt FROM events WHERE status = 'active' AND closeRequestStatus = 'sat'",
  ).all<TimeoutRow>();
  const now = Date.now();
  for (const row of results ?? []) {
    const action = closureTimeoutAction({ ...row, now });
    if (action === 'none') continue;
    if (action === 'reprompt') {
      await env.DB.prepare('UPDATE events SET closureRepromptAt = ? WHERE id = ?').bind(now, row.id).run();
      await audit(env, row.id, 'closure_confirmation_reprompted', null, null);
      await notifyClosureRequest(env, row.id, workerOrigin, 'sat');
    } else {
      await env.DB.prepare('UPDATE events SET closureAdvancedAt = ? WHERE id = ?').bind(now, row.id).run();
      await audit(env, row.id, 'closure_confirmation_advanced_tier', null, null);
      // Re-dispatch reaches the full support chain incl. the guardian tier. No
      // emergency-services fallback (Royce's P1) — that requires explicit confirm.
      await notifyClosureRequest(env, row.id, workerOrigin, 'sat');
    }
  }
}
