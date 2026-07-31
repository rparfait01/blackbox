/**
 * Capture completeness (Brief 38 §D/§E) — did this recording end normally?
 *
 * ORTHOGONAL TO THE CHAIN OUTCOME, and that separation is the point. Brief 37's verdict asks
 * whether the RECORD is trustworthy (VERIFIED / INCOMPLETE / PURGED_BY_CONSENT / BROKEN).
 * This asks whether the RECORDING ended normally. They are independent: a perfectly intact
 * chain can attest to a capture that was cut off when the phone was taken, and a capture that
 * ended cleanly can still have a damaged chain. Collapsing them would make each unreadable.
 *
 * ABNORMAL IS A FACT, NOT A FAULT. A device seized, destroyed, or with its battery pulled
 * mid-event is this product's threat model, not an edge case. The absence of a terminal marker
 * must never be reported as a defect or as tampering — a survivor whose phone was taken has
 * not produced defective evidence, and a verifier that says otherwise does harm at the exact
 * moment the evidence matters.
 */

import type { Env } from '../types';

export type CompletenessState = 'IN_PROGRESS' | 'COMPLETE' | 'COMPLETE_UNAUTHENTICATED' | 'ABNORMAL';

export interface CompletenessView {
  state: CompletenessState;
  lastSequence: number | null;
  /** §E — the exact sentence the report renders. Plain language, no jargon. */
  statement: string;
}

/**
 * §E — one of four sentences, and no others. Kept here rather than in the renderer so the
 * export, the report and the operator view cannot drift into describing the same state
 * differently.
 */
export function completenessStatement(state: CompletenessState, lastSequence: number | null, dtg: string | null): string {
  switch (state) {
    case 'COMPLETE':
      return 'Capture ended normally. All recorded segments are present and accounted for.';
    case 'COMPLETE_UNAUTHENTICATED':
      return (
        'Capture ended normally. All recorded segments are present. Segment integrity for this ' +
        'capture could not be cryptographically authenticated.'
      );
    case 'ABNORMAL':
      return (
        `Capture ended without a normal stop at ${dtg ?? 'an unrecorded time'}. ` +
        `Segments through sequence ${lastSequence ?? 0} are present. ` +
        'Segments after that point, if any, were not received.'
      );
    default:
      return 'Capture in progress.';
  }
}

/**
 * Record that a terminal chunk arrived, and decide which flavour of COMPLETE applies.
 *
 * `authenticated` is the server's OWN observation of the chunk's encryption state (Brief 36),
 * never the client's word: a chunk that travelled as UNENCRYPTED_DECLARED has no envelope, so
 * its marker cannot be authenticated even though it is truthful. That capture reports
 * COMPLETE (UNAUTHENTICATED MARKER) — deliberately not downgraded to ABNORMAL, because the
 * capture did end normally and saying otherwise is its own dishonesty.
 */
export async function markTerminalReceived(env: Env, eventId: string, sequence: number, authenticated: boolean): Promise<void> {
  const state: CompletenessState = authenticated ? 'COMPLETE' : 'COMPLETE_UNAUTHENTICATED';
  await env.DB.prepare(
    // Only from IN_PROGRESS. A capture already declared ABNORMAL by the server is not
    // resurrected by a late-arriving marker: the ordering guarantee it would be asserting
    // no longer holds, and the honest reading of a marker that arrives after the capture
    // was declared dead is that we cannot vouch for what came between.
    "UPDATE events SET completenessState = ?, lastSequenceReceived = ? WHERE id = ? AND completenessState = 'IN_PROGRESS'",
  )
    .bind(state, sequence, eventId)
    .run();
}

/**
 * §D — declare a capture ABNORMAL. Called by the SERVER on close, lifecycle timeout, or
 * heartbeat loss. It must not depend on the device, because the device is the thing that
 * stopped: a phone in a river cannot report that it is in a river.
 *
 * Idempotent and conservative: a capture that already reached a COMPLETE state keeps it, so a
 * normal close followed by the cron cannot rewrite a good capture into a bad one.
 */
export async function declareAbnormalIfUnfinished(env: Env, eventId: string): Promise<void> {
  const last = await env.DB.prepare('SELECT MAX(sequence) AS n FROM chunks_index WHERE eventId = ?')
    .bind(eventId)
    .first<{ n: number | null }>();
  await env.DB.prepare(
    "UPDATE events SET completenessState = 'ABNORMAL', lastSequenceReceived = ? WHERE id = ? AND completenessState = 'IN_PROGRESS'",
  )
    .bind(last?.n ?? null, eventId)
    .run();
}

/** Read the capture's completeness for the report and the export. */
export async function getCompleteness(env: Env, eventId: string): Promise<CompletenessView> {
  const row = await env.DB.prepare(
    'SELECT completenessState, lastSequenceReceived, closedAt, tzOffsetMinutes FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{ completenessState: string; lastSequenceReceived: number | null; closedAt: number | null; tzOffsetMinutes: number | null }>();
  // A CLOSED capture can never be "in progress", whatever the column happens to hold. This
  // guard exists because a default once said otherwise on five real production events, and a
  // report that states something false about evidence is worse than one that states nothing.
  // Backfilled by 0050; kept here so a future column default cannot reintroduce the lie.
  let state = (row?.completenessState ?? 'IN_PROGRESS') as CompletenessState;
  if (state === 'IN_PROGRESS' && row?.closedAt != null) {
    state = 'ABNORMAL';
  }
  const lastSequence = row?.lastSequenceReceived ?? null;
  const dtg = row?.closedAt ? new Date(row.closedAt).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : null;
  return { state, lastSequence, statement: completenessStatement(state, lastSequence, dtg) };
}

/**
 * §B/§C — may this chunk claim to be terminal? The server holds no key, so it cannot verify
 * the marker cryptographically; that happens at decrypt, where a forged marker no longer
 * matches the AAD the chunk was sealed under. What the server CAN do is refuse claims that
 * are structurally impossible, and it does:
 *
 *   - a terminal chunk cannot precede a chunk that already exists at a higher sequence,
 *     because then it was not last;
 *   - a second, different terminal claim cannot follow one already accepted.
 *
 * Returns a reason to reject, or null to accept. Deliberately narrow: this is not claimed to
 * be authentication, and overclaiming it would be worse than not having it.
 */
export async function terminalClaimProblem(env: Env, eventId: string, sequence: number): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(sequence) AS maxSeq, (SELECT COUNT(*) FROM chunks_index WHERE eventId = ? AND isFinal = 1 AND sequence <> ?) AS priorTerminal FROM chunks_index WHERE eventId = ?",
  )
    .bind(eventId, sequence, eventId)
    .first<{ maxSeq: number | null; priorTerminal: number }>();
  if (row && row.maxSeq != null && row.maxSeq > sequence) {
    return `terminal_claim_not_last (sequence ${sequence} but ${row.maxSeq} already stored)`;
  }
  if (row && Number(row.priorTerminal ?? 0) > 0) {
    return 'terminal_claim_duplicate';
  }
  return null;
}
