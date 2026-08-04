/**
 * BRIEF 56 §B — SHE DESTROYS HER OWN RECORDINGS.
 *
 * ═══ THE TWO THINGS THAT ARE BOTH TRUE ═══════════════════════════════════════════════════════
 *
 * The incident record belongs to her, and in this product deletion is a SAFETY feature: a
 * survivor whose abuser has found the app is carrying recordings that are dangerous to her.
 * Being unable to delete them is its own harm.
 *
 * And the opposite is equally true. That record may be the only account of what happened to her
 * that exists anywhere. It is what a court sees. A deletion made in a bad hour cannot be taken
 * back.
 *
 * The design holds both: MODERATE FRICTION, NEVER COERCION. Enough that the decision is
 * unmistakably intentional and informed; never enough to pressure, delay, or shame. The facts are
 * stated once, plainly, and then she decides. No confirmation loops, no typed keyword, no
 * cooling-off period, no support ticket, and nothing that argues with her.
 *
 * ═══ WHAT THIS MODULE IS, AND IS NOT ════════════════════════════════════════════════════════
 *
 * A transport. It holds no policy: the server owns ownership, the active-event refusal, and the
 * chain semantics, because those are safety properties and a client cannot be the one enforcing
 * them. This file exists so the UI never has to know how the endpoint is shaped.
 */

import { api } from '@/lib/api';

/** What the server reports about one purge — dry run or real. */
export interface PurgeOutcome {
  eventId: string;
  ok: boolean;
  /** Segments destroyed (or that WOULD be, on a dry run). */
  chunks: number;
  dryRun: boolean;
  /**
   * Named, never a bare failure. Each of these means something different to her and the UI says
   * which — §B5: a refusal is honest and states the reason, never a silent no-op.
   */
  reason?: 'not_found' | 'not_owner' | 'locked_during_active_alert' | 'already_purged' | 'network';
}

/**
 * §B2 step 2 — what WOULD be destroyed, straight from the server.
 *
 * The confirm screen must show the real number, not a client-side guess from a stale list. The
 * server runs the same enumeration the deletion runs, so the figure she agrees to is the figure
 * that goes.
 */
export async function previewPurge(eventId: string): Promise<PurgeOutcome> {
  return request(eventId, false);
}

/** §B2 step 3 — destroy the media for one event. Irreversible. */
export async function purgeCapture(eventId: string): Promise<PurgeOutcome> {
  return request(eventId, true);
}

async function request(eventId: string, confirm: boolean): Promise<PurgeOutcome> {
  const res = await api<{ chunks?: number; dryRun?: boolean; error?: string }>(
    `/v1/me/events/${eventId}/purge-capture`,
    // `api` serialises the body itself — passing a pre-stringified object would send the JSON
    // text as a JSON string and the server would read `confirm` as undefined, i.e. a dry run.
    // A "delete" that silently becomes a preview is the worst possible direction for this call.
    { method: 'POST', body: { confirm } },
  );
  // A REFUSAL IS NOT A NETWORK FAILURE, and the order of these checks is what keeps them apart.
  // The server answers 403/404/409 with a named reason in the body, so `res.ok` is false for
  // both "you may not do this, because your alert is live" and "the request never arrived".
  // Reading `res.ok` first would collapse the two and tell her nothing was deleted for the wrong
  // reason — §B5 requires the refusal to state which.
  if (res.data?.error) {
    return {
      eventId,
      ok: false,
      chunks: 0,
      dryRun: !confirm,
      reason: res.data.error as PurgeOutcome['reason'],
    };
  }
  if (!res.ok || !res.data) {
    return { eventId, ok: false, chunks: 0, dryRun: !confirm, reason: 'network' };
  }
  return { eventId, ok: true, chunks: res.data.chunks ?? 0, dryRun: res.data.dryRun === true };
}

/**
 * §B6.3 — BULK DELETION IS BATCHED, AND IT REPORTS AS IT GOES.
 *
 * A survivor with 200 recordings deleting all of them iterates 200 server round trips, each
 * enumerating and deleting R2 objects. Fired all at once that is a request storm against the same
 * account; run silently in sequence it is a screen that appears frozen for a minute while the
 * most consequential action in the app happens invisibly.
 *
 * So: a small fixed concurrency, and `onProgress` after every completion. The UI is expected to
 * render a live count — she is entitled to see the thing she asked for actually happening.
 *
 * ONE FAILURE NEVER STOPS THE REST. Each event is independent; a refusal on one (an event that
 * went active again, one already purged) is recorded in its own outcome and the others proceed.
 * The caller reports the failures individually rather than a single "something went wrong",
 * because "3 of 12 could not be deleted, and here they are" is the only useful thing to say.
 */
export const PURGE_CONCURRENCY = 3;

export async function purgeMany(
  eventIds: string[],
  onProgress: (done: number, total: number, latest: PurgeOutcome) => void,
): Promise<PurgeOutcome[]> {
  const outcomes: PurgeOutcome[] = [];
  const queue = [...eventIds];
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const outcome = await purgeCapture(next).catch(
        (): PurgeOutcome => ({ eventId: next, ok: false, chunks: 0, dryRun: false, reason: 'network' }),
      );
      outcomes.push(outcome);
      done += 1;
      onProgress(done, eventIds.length, outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.min(PURGE_CONCURRENCY, eventIds.length) }, worker));
  return outcomes;
}

/** The reader-facing reason a deletion was refused. Plain language, and it says WHY. */
export function purgeRefusalText(reason: PurgeOutcome['reason']): string {
  switch (reason) {
    case 'locked_during_active_alert':
      // §B5 — and the reason is stated rather than hidden behind "unavailable". This refusal
      // protects her: mid-alert, "delete my recordings" is the button an aggressor reaches for.
      return 'This alert is still active. Recordings cannot be deleted while an alert is running — that protection exists so nobody can destroy your evidence during an incident. You can delete it once the alert is closed.';
    case 'already_purged':
      return 'The recordings for this entry were already deleted.';
    case 'not_found':
      return 'That entry no longer exists.';
    case 'not_owner':
      return 'That entry does not belong to this account.';
    default:
      return 'Could not reach the server, so nothing was deleted. Your recordings are untouched.';
  }
}
