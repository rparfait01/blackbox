/**
 * Pure lifecycle predicates shared by the Worker (enforcement) and the PWA (UI
 * gating), so both sides agree on the same rules and the rules are unit-testable
 * without a database or a live Worker.
 *
 * These close the "trapped in an unclosable active event" hole:
 *   - armability: never reach an armed state that would notify no one.
 *   - link reissue: a coordinator link on an unresolved event must regenerate
 *     when it expires, so the path to closure never dead-ends.
 */

/** One recipient slot, reduced to only what armability depends on. */
export interface RecipientReachability {
  role: 'contact' | 'guardian' | 'emergency' | string;
  /** True only if this slot's channel can ACTUALLY deliver in this deployment. */
  deliverable: boolean;
}

/**
 * Can the account arm? True iff at least one recipient that would actually be
 * reached exists: any deliverable Contact, OR the Guardian when it is enabled and
 * deliverable. The 'emergency' fallback slot does NOT count — it fires only after
 * the chain completes unclaimed, so it can't be the sole path. An alert that
 * would notify no one is the deadlock; this predicate forbids reaching it.
 */
export function hasReachableRecipient(
  recipients: RecipientReachability[],
  guardianEnabled: boolean,
): boolean {
  return recipients.some((r) => {
    if (!r.deliverable) {
      return false;
    }
    if (r.role === 'contact') {
      return true;
    }
    if (r.role === 'guardian') {
      return guardianEnabled;
    }
    return false; // 'emergency' / unknown roles never satisfy armability alone
  });
}

/**
 * Is an active event's coordinator link expired and in need of reissue? True iff
 * the event is unresolved (still active, no coordinator claimed), a link was
 * actually sent before (notifiedAt + lastLinkIssuedAt set), and at least one full
 * TTL has elapsed since it was last minted. Keeping this pure lets the cron and
 * tests share one definition of "due".
 */
export function isLinkReissueDue(args: {
  now: number;
  status: string;
  coordinatorClaimedAt: number | null;
  notifiedAt: number | null;
  lastLinkIssuedAt: number | null;
  ttlMs: number;
}): boolean {
  const { now, status, coordinatorClaimedAt, notifiedAt, lastLinkIssuedAt, ttlMs } = args;
  if (status !== 'active') {
    return false;
  }
  if (coordinatorClaimedAt != null) {
    return false;
  }
  if (notifiedAt == null || lastLinkIssuedAt == null) {
    return false;
  }
  return now - lastLinkIssuedAt >= ttlMs;
}
