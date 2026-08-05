import type { Env } from '../types';

/**
 * BRIEF 58 — PER-ROUTE REQUEST TELEMETRY, BECAUSE A MILLION REQUESTS LEFT NO TRACE.
 *
 * ═══ WHAT THIS EXISTS TO PREVENT ═════════════════════════════════════════════════════════════
 *
 * A runaway client spent 1,038,439 requests in one day against `/v1/c/:id/audio/:sequence`. It
 * took a week to find, and the reason is that nothing recorded it:
 *
 *   * Cloudflare's `workersInvocationsAdaptive` has NO path dimension. It could say 66,500/hour
 *     and not which route.
 *   * The route rejected before any write, so D1 held no row, the audit log held no row, and
 *     `capture_access_log` had zero rows in its entire existence.
 *   * The structured `console.log` in the middleware goes to a stream nothing retains — the same
 *     "fires into console.log and nobody watches those" defect the operator-alert channel was
 *     built to fix, still present one layer down.
 *
 * So the diagnosis had to be reconstructed from a rate, a flat line, and a subrequest count.
 * That worked, and it should not have been necessary.
 *
 * ═══ THE CARDINALITY RULE ════════════════════════════════════════════════════════════════════
 *
 * Paths carry event ids, sequence numbers and tokens. Writing raw paths would produce a
 * high-cardinality index that is expensive and useless — a million distinct values, each seen
 * once. So the path is NORMALISED to its route template before it is written, and the
 * normaliser is a fixed table rather than a heuristic: an unrecognised path collapses to
 * `/other`, which is a signal in itself (a route nobody templated is being hit hard).
 *
 * NOTHING IDENTIFYING IS WRITTEN. No token, no event id, no user id, no IP, no body. The route
 * template and the status code, and that is all — this is a traffic instrument, not an access
 * log, and an access log on this product would itself be a disclosure risk.
 */

/**
 * Collapse a concrete path to a route template.
 *
 * Ordered longest-prefix-first where it matters, because `/v1/c/:id/audio/:seq` must not be
 * shadowed by `/v1/c/:id`.
 */
export function routeTemplate(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/';

  // Coordinator surface — the highest-volume family and the one that ran away.
  if (/^\/v1\/c\/[^/]+\/audio\/\d+$/.test(p)) return '/v1/c/:id/audio/:seq';
  if (/^\/v1\/c\/[^/]+\/audio\/(full|latest)$/.test(p)) return '/v1/c/:id/audio/full';
  if (/^\/v1\/c\/[^/]+\/[a-z-]+\/stream$/.test(p)) return '/v1/c/:id/:kind/stream';
  if (/^\/v1\/c\/[^/]+\/[a-z-]+\/[^/]+$/.test(p)) return '/v1/c/:id/:action/:arg';
  if (/^\/v1\/c\/[^/]+\/[a-z-]+$/.test(p)) return '/v1/c/:id/:action';
  if (/^\/v1\/c\/[^/]+$/.test(p)) return '/v1/c/:id';
  if (/^\/c\/[^/]+$/.test(p)) return '/c/:id';

  // Capture upload path.
  if (/^\/v1\/events\/[^/]+\/[a-z-]+$/.test(p)) return '/v1/events/:id/:action';
  if (/^\/v1\/events\/[^/]+$/.test(p)) return '/v1/events/:id';

  // Owner surface.
  if (/^\/v1\/me\/reports\/events\/[^/]+\/chunks\/\d+$/.test(p)) return '/v1/me/reports/events/:id/chunks/:seq';
  if (/^\/v1\/me\/reports\/events\/[^/]+\/[a-z-]+$/.test(p)) return '/v1/me/reports/events/:id/:action';
  if (/^\/v1\/me\/events\/[^/]+\/[a-z-]+$/.test(p)) return '/v1/me/events/:id/:action';
  if (/^\/v1\/me\//.test(p)) return p.split('/').slice(0, 4).join('/');

  if (/^\/v1\/admin\//.test(p)) return '/v1/admin/*';
  if (p === '/version' || p === '/health') return p;
  if (/^\/v1\/[a-z-]+$/.test(p)) return p;
  return '/other';
}

/**
 * Record one request. Never throws, never awaits.
 *
 * `writeDataPoint` is fire-and-forget by design, and the binding is OPTIONAL — a deployment
 * without it serves every request unchanged. Telemetry that can take the alert path down is
 * worse than no telemetry, which is the whole lesson of the thing it was built to observe.
 */
export function recordRequest(env: Env, route: string, status: number, method: string, ms: number): void {
  try {
    env.REQUEST_TELEMETRY?.writeDataPoint({
      // Indexed: the dimension we group by. One value per route template.
      indexes: [route],
      blobs: [route, method, String(status)],
      doubles: [1, ms, status],
    });
  } catch {
    // An instrument that can break the thing it measures is not an instrument.
  }
}
