/**
 * Orphaned-capture purge (Brief 32 follow-up) — the CORRECT mechanism for clearing R2
 * residue, replacing the lifecycle rule that was reverted as a P0.
 *
 * WHY NOT A LIFECYCLE RULE. No R2 lifecycle rule can satisfy "never delete a new capture".
 * `--expire-date` applies to every matching object regardless of age, so it kills new
 * captures immediately; `--expire-days N` kills them N days later. Prefix scoping cannot
 * help either, because keys are `events/<uuid>/chunks/N` and a UUID carries no time
 * ordering. A standing rule that eventually eats live captures is a suspended safety
 * guarantee — retention outranks cleanup, always.
 *
 * WHAT THIS DOES INSTEAD: enumerates objects by identity and deletes only the ones that
 * are provably safe, under TWO independent guards. It leaves no standing rule behind, so
 * when it finishes running, nothing in the system is scheduled to delete anything.
 *
 *   GUARD 1 — THE CUTOFF. A timestamp is taken when the request starts, and an object is
 *   only eligible if it was uploaded STRICTLY BEFORE it. A purge can page through R2 for
 *   a long time; without this, an object written midway through the run could be listed
 *   and deleted. With it, anything created after invocation is excluded by construction,
 *   which is the property that was violated last time.
 *
 *   GUARD 2 — THE D1 REFERENCE. An object still named by `chunks_index` is a LIVE capture,
 *   not residue, and is never deleted no matter how old it is. Today `chunks_index` is
 *   empty so every object is orphaned, but this guard is what makes the endpoint safe to
 *   run again later, when real captures exist.
 *
 * Both guards must pass. They fail closed: an object is deleted only when it is provably
 * old AND provably unreferenced.
 */
import type { Env } from '../types';

export interface PurgeResult {
  /** Objects uploaded at or after this are excluded, whatever else is true. */
  cutoff: number;
  /** Listed from R2 this run. */
  scanned: number;
  /** Eligible: older than the cutoff AND not referenced by chunks_index. */
  eligible: number;
  /** Actually deleted (0 on a dry run). */
  deleted: number;
  /** Excluded because they were uploaded at/after the cutoff — i.e. NEW captures. */
  skippedTooNew: number;
  /** Excluded because chunks_index still references them — i.e. LIVE captures. */
  skippedReferenced: number;
  /** False when the cap was hit and more objects remain; call again to continue. */
  done: boolean;
  /** True when nothing was deleted because `confirm` was not set. */
  dryRun: boolean;
}

/** R2 accepts up to 1000 keys per bulk delete. */
const DELETE_BATCH = 1000;
/** Per-invocation ceiling so a single request cannot exceed Worker limits. The caller
 *  re-invokes until `done` — resumable by design rather than one heroic request. */
const DEFAULT_MAX = 5000;

/** Every r2Key D1 still references. These are LIVE captures and are never purged. */
async function referencedKeys(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare('SELECT r2Key FROM chunks_index').all<{ r2Key: string }>();
  return new Set((results ?? []).map((r) => r.r2Key));
}

/**
 * Purge orphaned capture objects from the MEDIA bucket.
 *
 * @param confirm  MUST be true to delete. Anything else performs a DRY RUN that reports
 *                 exactly what would go without touching a byte — because an endpoint
 *                 that mass-deletes storage should not do so on a malformed request.
 */
export async function purgeOrphanedMedia(
  env: Env,
  opts: { confirm: boolean; maxObjects?: number; now?: number },
): Promise<PurgeResult> {
  const cutoff = opts.now ?? Date.now();
  const max = Math.max(1, Math.min(opts.maxObjects ?? DEFAULT_MAX, 50_000));
  const referenced = await referencedKeys(env);

  const result: PurgeResult = {
    cutoff,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skippedTooNew: 0,
    skippedReferenced: 0,
    done: false,
    dryRun: opts.confirm !== true,
  };

  let cursor: string | undefined;
  let pending: string[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    if (!result.dryRun) {
      await env.MEDIA.delete(pending);
      result.deleted += pending.length;
    }
    pending = [];
  };

  for (;;) {
    const page = await env.MEDIA.list({ limit: 1000, cursor });
    for (const object of page.objects) {
      result.scanned += 1;
      // GUARD 1 — anything uploaded at or after the cutoff is a new capture. Excluded.
      if (object.uploaded.getTime() >= cutoff) {
        result.skippedTooNew += 1;
        continue;
      }
      // GUARD 2 — still referenced by D1 means a live capture, whatever its age.
      if (referenced.has(object.key)) {
        result.skippedReferenced += 1;
        continue;
      }
      result.eligible += 1;
      pending.push(object.key);
      if (pending.length >= DELETE_BATCH) await flush();
    }

    cursor = page.truncated ? page.cursor : undefined;
    if (!cursor) {
      await flush();
      result.done = true;
      return result;
    }
    if (result.scanned >= max) {
      // Cap reached with more to go: stop cleanly and report done:false so the operator
      // re-invokes. Better a resumable purge than one request that dies half way.
      await flush();
      result.done = false;
      return result;
    }
  }
}
