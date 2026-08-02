/**
 * Request headroom against the plan limit (Brief 33 Fix A §F).
 *
 * WHY THIS EXISTS. There was no request-volume visibility of any kind, so a billing threshold
 * presented itself as a platform incident: the Worker returned 521/522, and the reading taken
 * at the time — including mine — was that Cloudflare was having a bad day. It was the account
 * being cut off at the free-tier daily cap, by our own unbounded polling loop.
 *
 * The Worker is the entire alert path. Crossing a request threshold takes it down as
 * completely as any bug would, and until now nothing in the system could see it coming. That
 * is the Brief 35 silent-failure class arriving through the billing layer, and it deserves the
 * same treatment: report what is TRUE, counted, next to the claim.
 *
 * HONESTY ABOUT THE SOURCE. Cloudflare does not expose a request counter to the Worker
 * runtime, so this reads the GraphQL Analytics API — an outbound call needing an account token
 * with Analytics:Read. When the token is absent this reports NOT CONFIGURED and says so. It
 * never estimates, and it never reports a number it did not fetch: an invented headroom figure
 * on this panel would be worse than none, because it is the thing an operator would rely on
 * before assuming they had room.
 */

import type { Env } from '../types';

/** Free tier is 100k requests/day. Set PLAN_DAILY_REQUESTS when the plan changes. */
export const DEFAULT_DAILY_LIMIT = 100_000;

/** §F — error-level alert at this fraction of the limit. */
export const HEADROOM_ALERT_AT = 0.8;

export interface RequestHeadroom {
  configured: boolean;
  summary: string;
  limit: number;
  used: number | null;
  remaining: number | null;
  usedFraction: number | null;
  /** True once usage crosses HEADROOM_ALERT_AT — the panel and the log both act on this. */
  alerting: boolean;
  note: string;
}

function planLimit(env: Env): number {
  const raw = Number(env.PLAN_DAILY_REQUESTS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_LIMIT;
}

/**
 * Today's Workers request count from the GraphQL Analytics API.
 *
 * Returns null — never a guess — when unconfigured or unreachable. A failure here must not
 * fail the readiness panel: the panel's job is to report what is true, and "I could not find
 * out" is a true thing to report.
 */
async function fetchUsedToday(env: Env): Promise<number | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return null;
  }
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const query = `{ viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
      workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: "${since.toISOString()}"}) {
        sum { requests }
      } } } }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } };
    };
    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    return rows.reduce((n, r) => n + Number(r.sum?.requests ?? 0), 0);
  } catch {
    return null;
  }
}

export async function requestHeadroom(env: Env): Promise<RequestHeadroom> {
  const limit = planLimit(env);
  const used = await fetchUsedToday(env);
  if (used == null) {
    return {
      configured: false,
      summary: 'REQUESTS: NOT MEASURED — no analytics token configured',
      limit,
      used: null,
      remaining: null,
      usedFraction: null,
      alerting: false,
      // Named plainly, because the absence of this measurement is what let a quota breach be
      // mistaken for a platform incident for a month.
      note: 'Set CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID (Analytics:Read) to report headroom. Until then the alert path can cross its request limit unobserved.',
    };
  }
  const fraction = used / limit;
  const alerting = fraction >= HEADROOM_ALERT_AT;
  if (alerting) {
    // §F — error level. The consequence of crossing the limit is that a survivor's trigger
    // notifies nobody, so this is not a capacity warning; it is an alert-path outage warning.
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'request_headroom_low',
        message: 'daily Workers requests approaching the plan limit — the alert path fails when it is reached',
        used,
        limit,
        percent: Math.round(fraction * 100),
      }),
    );
  }
  return {
    configured: true,
    summary: `REQUESTS: ${used.toLocaleString()}/${limit.toLocaleString()} today (${Math.round(fraction * 100)}%)${alerting ? ' · ALERT' : ''}`,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    usedFraction: fraction,
    alerting,
    note:
      'Counted from the Cloudflare GraphQL Analytics API. The Worker is the whole alert path: at 100% a trigger creates a local capture and notifies nobody.',
  };
}
