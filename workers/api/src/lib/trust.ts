/**
 * Recipient / agency trust scoring (Fix Brief 2 #C5). An internal operational
 * record — accountability, not public judgment. We track, per recipient AND per
 * agency: identity verified?, custody acknowledged?, integrity challenges
 * issued/answered, investigation cooperation, and response latency. A derived
 * 0–100 score lets the operator see reliability and (later) route to
 * higher-trust recipients.
 *
 * Canonical time is UTC ms + offset (#C6).
 */

import type { Env } from '../types';

export type TrustSubject = 'recipient' | 'agency';

export interface TrustRow {
  subjectType: TrustSubject;
  subjectId: string;
  identityVerified: number;
  custodyAcknowledged: number;
  challengesIssued: number;
  challengesAnswered: number;
  investigationsCooperated: number;
  investigationsTotal: number;
  responseLatencyMsTotal: number;
  responseLatencyCount: number;
  updatedAt: number;
  tzOffsetMinutes: number | null;
}

async function ensureRow(env: Env, type: TrustSubject, id: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO trust_records (subjectType, subjectId, updatedAt, tzOffsetMinutes) VALUES (?, ?, ?, ?)',
  )
    .bind(type, id, Date.now(), 0)
    .run();
}

/**
 * Apply a delta to a subject's trust counters. Booleans are set (max), counters
 * are incremented. Updates both the recipient and (if given) its agency.
 */
export async function bumpTrust(
  env: Env,
  subjects: Array<{ type: TrustSubject; id: string }>,
  delta: Partial<{
    identityVerified: boolean;
    custodyAcknowledged: boolean;
    challengesIssued: number;
    challengesAnswered: number;
    investigationsCooperated: number;
    investigationsTotal: number;
    responseLatencyMs: number;
  }>,
): Promise<void> {
  for (const s of subjects) {
    if (!s.id) {
      continue;
    }
    await ensureRow(env, s.type, s.id);
    const sets: string[] = ['updatedAt = ?'];
    const binds: unknown[] = [Date.now()];
    if (delta.identityVerified) {
      sets.push('identityVerified = 1');
    }
    if (delta.custodyAcknowledged) {
      sets.push('custodyAcknowledged = 1');
    }
    if (delta.challengesIssued) {
      sets.push('challengesIssued = challengesIssued + ?');
      binds.push(delta.challengesIssued);
    }
    if (delta.challengesAnswered) {
      sets.push('challengesAnswered = challengesAnswered + ?');
      binds.push(delta.challengesAnswered);
    }
    if (delta.investigationsCooperated) {
      sets.push('investigationsCooperated = investigationsCooperated + ?');
      binds.push(delta.investigationsCooperated);
    }
    if (delta.investigationsTotal) {
      sets.push('investigationsTotal = investigationsTotal + ?');
      binds.push(delta.investigationsTotal);
    }
    if (typeof delta.responseLatencyMs === 'number') {
      sets.push('responseLatencyMsTotal = responseLatencyMsTotal + ?', 'responseLatencyCount = responseLatencyCount + 1');
      binds.push(delta.responseLatencyMs);
    }
    binds.push(s.type, s.id);
    await env.DB.prepare(
      `UPDATE trust_records SET ${sets.join(', ')} WHERE subjectType = ? AND subjectId = ?`,
    )
      .bind(...binds)
      .run();
  }
}

/**
 * Derive a 0–100 trust score: identity (30) + custody ack (20) + challenge
 * answer rate (25) + investigation cooperation (25). Non-cooperation pulls it
 * down because the denominators (issued / total) count against an unanswered
 * recipient.
 */
export function trustScore(r: TrustRow): number {
  let score = 0;
  if (r.identityVerified) score += 30;
  if (r.custodyAcknowledged) score += 20;
  score += r.challengesIssued > 0 ? (r.challengesAnswered / r.challengesIssued) * 25 : 25;
  score += r.investigationsTotal > 0 ? (r.investigationsCooperated / r.investigationsTotal) * 25 : 25;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export interface TrustView extends TrustRow {
  score: number;
  avgResponseLatencyMs: number | null;
  nonCooperation: boolean;
}

function toView(r: TrustRow): TrustView {
  return {
    ...r,
    score: trustScore(r),
    avgResponseLatencyMs:
      r.responseLatencyCount > 0 ? Math.round(r.responseLatencyMsTotal / r.responseLatencyCount) : null,
    // Flag any subject that was challenged or investigated but did not answer.
    nonCooperation:
      (r.challengesIssued > r.challengesAnswered) ||
      (r.investigationsTotal > r.investigationsCooperated),
  };
}

export async function getTrust(env: Env, type: TrustSubject, id: string): Promise<TrustView | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM trust_records WHERE subjectType = ? AND subjectId = ?',
  )
    .bind(type, id)
    .first<TrustRow>();
  return row ? toView(row) : null;
}

export async function listTrust(env: Env): Promise<TrustView[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM trust_records ORDER BY subjectType, subjectId',
  ).all<TrustRow>();
  return (results ?? []).map(toView);
}
