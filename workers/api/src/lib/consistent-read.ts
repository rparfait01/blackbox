import type { Env } from '../types';

/**
 * READ-YOUR-WRITES FOR GATES. D1 serves reads from replicas, and a gate that reads a replica
 * decides on a state that may already be false.
 *
 * ═══ THE DEFECT THIS EXISTS FOR ══════════════════════════════════════════════════════════════
 *
 * An org adds its second admin. The write succeeds. The next request asks
 * `countActiveAdmins()` whether seat issuance may unlock, that read lands on a replica which has
 * not caught up, it counts one admin, and the org is told **"Add a second admin before enrolling
 * survivors"** — immediately after adding one. There is nothing they can do about it and no
 * indication it will pass if they wait.
 *
 * Found as an intermittent acceptance failure (check 50) that passed in isolation and failed
 * under concurrent load. A flaky test was the symptom; the defect is real and user-visible.
 *
 * ═══ WHY NOT THE BRIEF 37 ANSWER ═════════════════════════════════════════════════════════════
 *
 * Brief 37 hit the same class on the integrity chain head and moved ownership into a Durable
 * Object, because there the head is a single mutable pointer with one writer and strict ordering
 * requirements. A membership COUNT is neither: it is derived from rows many requests write, and
 * a DO would put a serialization point in front of every org read to fix a staleness window.
 *
 * The right tool is D1's own session constraint. `first-primary` sends the read to the primary,
 * so it observes every committed write. Serializing callers cannot repair an eventually
 * consistent read — only reading from something that has the write can.
 *
 * ═══ WHEN TO USE THIS, AND WHEN NOT TO ═══════════════════════════════════════════════════════
 *
 * USE IT when a count or existence check GATES a user-visible state — the caller will be told
 * "you may not do this" and a stale read makes that a lie.
 *
 * DO NOT use it for reads that merely display, aggregate, or report. A dashboard number one
 * second stale is fine; primary reads cost latency and give up the read scaling replicas exist
 * for. This is a correctness tool for decisions, not a default.
 *
 * NEVER on the capture or alert path. Those must not gain a dependency on primary availability;
 * they fail open by design and none of them gates on a count.
 */

/**
 * Run a read against the PRIMARY, so it sees every committed write.
 *
 * Falls back to the ordinary binding when the runtime does not expose sessions — an older
 * workerd, or a test double. A stale read is the current behaviour, so the fallback is no worse
 * than before and never an error.
 */
export async function readConsistent<T>(env: Env, run: (db: D1Database) => Promise<T>): Promise<T> {
  try {
    const withSession = (env.DB as unknown as { withSession?: (c: string) => D1Database }).withSession;
    if (typeof withSession === 'function') {
      return await run(withSession.call(env.DB, 'first-primary'));
    }
  } catch {
    // A session that cannot be created is not a reason to fail the read.
  }
  return run(env.DB);
}
