/**
 * Per-token poll ceiling for the coordinator state endpoint (Brief 33 Fix A §E1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CANNOT DO, SAID FIRST SO NOBODY BUILDS ON A FALSE FLOOR.
 *
 * This does NOT protect the Workers request cap. By the time any line of this file executes,
 * the request has already arrived, already invoked the Worker, and already been counted
 * against the daily limit. A rate limiter cannot un-count a request it is answering.
 *
 * So the outage that motivated this brief would NOT have been prevented by this file. Only
 * two things reduce Workers requests: the client loop stopping (§A–§D), and stale tabs being
 * closed. A ceiling that is described as quota protection would be exactly the overclaim
 * Brief 38 §B had to correct.
 *
 * WHAT IT DOES DO, which is still worth having:
 *   - Cuts the DOWNSTREAM cost of a runaway loop — each refused poll skips the D1 reads that
 *     build a full contact-state payload, so a stuck tab stops doing real work.
 *   - Gives any client that understands it an explicit, terminal instruction to stop.
 *   - Makes a runaway loop VISIBLE, which is how this went unnoticed for a month.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CEILING IS GENEROUS ON PURPOSE. A coordinator watching a live alert is the product
 * working; throttling them would be a worse failure than the one being fixed. The live limit
 * sits well above the 3s cadence the page actually uses, so it bites only on something that
 * has genuinely run away.
 *
 * State is per-isolate and in memory. That is deliberate: a D1-backed counter would add a
 * write to every poll — paying for the fix with the resource being conserved — and a Durable
 * Object would add a DO request per poll for the same reason. Per-isolate counting
 * undercounts a distributed flood, which is acceptable because this is a runaway-loop guard,
 * not a security control.
 */

/** Live event: 40 polls/min per token. The page polls at 3s (20/min), so this is 2x headroom. */
export const LIVE_LIMIT_PER_MIN = 40;

/**
 * Closed event: 6/min. A conforming client stops entirely on closure, so anything still
 * asking is a stale page — allowed enough to receive and act on the terminal payload, and no
 * more.
 */
export const CLOSED_LIMIT_PER_MIN = 6;

const WINDOW_MS = 60_000;

interface Bucket {
  windowStart: number;
  count: number;
}

/** Per-isolate, evicted by age. Never persisted — see the header. */
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(k);
  }
}

export interface CeilingDecision {
  allowed: boolean;
  /** Polls seen in the current window, for the refusal payload and for observability. */
  count: number;
  limit: number;
}

/**
 * Count this poll and decide whether to serve it.
 *
 * §E1 — "never rate-limit a live event's first poll". The FIRST request for any token always
 * passes: a fresh bucket starts at zero and is only refused once it has crossed the limit
 * inside a single window, so a coordinator opening the dashboard is never met with a refusal.
 */
export function checkPollCeiling(token: string, eventId: string, isLive: boolean, now = Date.now()): CeilingDecision {
  const limit = isLive ? LIVE_LIMIT_PER_MIN : CLOSED_LIMIT_PER_MIN;
  // Key on the token, not the event: a token is one viewer, and one runaway tab must not
  // throttle a different coordinator watching the same event.
  const key = `${eventId}:${token.slice(0, 32)}`;
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    prune(now);
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, count: 1, limit };
  }
  existing.count += 1;
  return { allowed: existing.count <= limit, count: existing.count, limit };
}

/** Test seam — reset between cases. */
export function __resetPollCeiling(): void {
  buckets.clear();
}
