/**
 * Brief 41 §E3/§E4 — THE LIMITER'S STORE.
 *
 * §E4 — REJECT BEFORE ANY D1 READ. Limiting consumes requests in order to reject requests, so the
 * accounting has to be cheaper than the thing it protects. This counts in ISOLATE MEMORY: no
 * database, no Durable Object hop, no network, no billable subrequest. A flood against one colo
 * dies in that colo for free.
 *
 * WHAT THAT HONESTLY DOES NOT DO, stated because the alternative is a control that reads stronger
 * than it is (the defect class this project has hit five times). Cloudflare runs many isolates,
 * so an attacker distributed across colos gets one bucket per colo rather than one globally. This
 * is a SPEED BUMP against distributed abuse and a real stop against the ordinary case: a script
 * pointed at one endpoint from one place, which is what actually drains a quota.
 *
 * The globally-correct control is elsewhere and is the one that matters: §C caps outbound sends at
 * the single choke point every message already passes through, and the alert path draws on a
 * reserved allocation that non-alert traffic can never consume. That is enforced per identifier in
 * D1, on the send path, where a database read is affordable because the alternative is a provider
 * call costing far more.
 *
 * §E3 — every function here returns rather than throws. A limiter that fails closed converts a
 * storage blip into an outage of the front door.
 */
import type { Env } from '../types';

interface Bucket {
  count: number;
  windowStartedAt: number;
}

/** Per-isolate. Bounded so a flood of distinct identifiers cannot grow this without limit. */
const buckets = new Map<string, Bucket>();
const MAX_TRACKED = 10_000;

/**
 * Record an attempt and return how many have happened in the current window.
 *
 * Returns null if the count could not be established, which the caller must treat as ALLOW (§E3).
 */
export function countAttempt(key: string, windowMs: number, now = Date.now()): number | null {
  try {
    if (buckets.size > MAX_TRACKED) {
      // Evict the oldest windows rather than refusing to track: an attacker cycling identifiers
      // must not be able to make the limiter fail closed for everyone else, and must not be able
      // to grow isolate memory without bound either.
      for (const [k, b] of buckets) {
        if (now - b.windowStartedAt > windowMs) buckets.delete(k);
        if (buckets.size <= MAX_TRACKED / 2) break;
      }
    }
    const existing = buckets.get(key);
    if (!existing || now - existing.windowStartedAt >= windowMs) {
      buckets.set(key, { count: 1, windowStartedAt: now });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  } catch {
    return null;
  }
}

/** Test seam and operational reset. */
export function resetLimiter(): void {
  buckets.clear();
}

export function limiterSize(): number {
  return buckets.size;
}

/**
 * §C — the outbound cap, counted in D1 because it must hold ACROSS isolates: the whole point is a
 * finite provider quota that any one attacker could drain from anywhere.
 *
 * Returns `{ allowed }`. On any storage failure it ALLOWS — a survivor's magic link must not be
 * withheld because a counter table was briefly unreachable (§E3).
 */
export async function countOutbound(
  env: Env,
  identifier: string,
  windowMs: number,
  max: number,
  now = Date.now(),
): Promise<{ allowed: boolean; used: number; failedOpen: boolean }> {
  try {
    const since = now - windowMs;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbound_attempts WHERE identifier = ? AND createdAt >= ?",
    )
      .bind(identifier, since)
      .first<{ n: number }>();
    const used = Number(row?.n ?? 0);
    if (used >= max) return { allowed: false, used, failedOpen: false };
    await env.DB.prepare('INSERT INTO outbound_attempts (identifier, createdAt) VALUES (?, ?)')
      .bind(identifier, now)
      .run();
    return { allowed: true, used: used + 1, failedOpen: false };
  } catch {
    return { allowed: true, used: 0, failedOpen: true };
  }
}

/** Headroom for the readiness panel (§C). Never a guess: null when it cannot be read. */
export async function outboundHeadroom(env: Env, windowMs: number, max: number, now = Date.now()) {
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT identifier) AS ids FROM outbound_attempts WHERE createdAt >= ?',
    )
      .bind(now - windowMs)
      .first<{ n: number; ids: number }>();
    return {
      configured: true,
      windowMs,
      perIdentifierMax: max,
      sendsInWindow: Number(row?.n ?? 0),
      identifiersInWindow: Number(row?.ids ?? 0),
      summary: `OUTBOUND: ${Number(row?.n ?? 0)} non-alert send(s) in the last hour across ${Number(row?.ids ?? 0)} identifier(s) · cap ${max}/identifier · the alert path is not counted here and cannot be blocked by it`,
    };
  } catch {
    return { configured: false, summary: 'OUTBOUND: NOT MEASURED (counter unavailable)' };
  }
}
