/**
 * Scheduled handler (Cron Trigger). Two jobs:
 *
 *  1. "Device went dark" escalation (Fix Brief 1 #3). Any event still `active`
 *     whose heartbeat has gone stale is escalated exactly once. A missed
 *     heartbeat NEVER auto-closes — interruption escalates, never cancels.
 *
 *  2. Vault integrity scan (Fix Brief 2 #C4) — see lib/integrity. Re-hashes
 *     sealed artifacts, and on any mismatch fires a tamper alert + opens an
 *     investigation record.
 *
 * The worker's own public origin (for dashboard magic-links) comes from
 * WORKER_ORIGIN since a cron run has no request URL.
 */

import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { advanceCascades, notifyEscalation, reissueExpiredLinks } from './lib/notify';
import { runIntegrityScan } from './lib/integrity';
import { closeFeedLostEvents, closeOrphanedEvents, runEscalation } from './lib/closure-timeout';
import { sweepExpiredCanaryEvents } from './lib/canary';
import { alertOnUnsealed, drainSealQueue } from './lib/seal';
import { drainAlertSummaries } from './lib/operator-alert';
import type { Env } from './types';

/** A heartbeat is "stale" after this long without a ping (heartbeat is every 10s). */
const HEARTBEAT_STALE_MS = 35_000;

/**
 * Per-job ceiling for the cron chain (Brief 36 — waitUntil audit).
 *
 * Every job below runs SEQUENTIALLY inside one waitUntil. Each is already wrapped in its
 * own try/catch, so a job that THROWS cannot stop the ones after it — but a job that HANGS
 * can, and silently: an unresolved D1 call in `escalateDarkDevices` starves the integrity
 * scan and the canary TTL sweep for that whole minute, with nothing recorded anywhere.
 *
 * That is the same family as the §11 cascade defect — a long chain completing partially and
 * saying nothing — reached by a different route. A ceiling per job converts an invisible
 * starvation into a logged, bounded one, and the next minute's cron picks the work up.
 */
const JOB_TIMEOUT_MS = 20_000;

/** Run a cron job under a ceiling. A job that overruns is LOGGED and abandoned so the
 *  jobs behind it still run; it is never awaited indefinitely. */
async function boundedJob(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`job exceeded ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', job: name, detail: String(error) }));
  }
}

function workerOrigin(env: Env): string {
  return env.WORKER_ORIGIN || env.PWA_ORIGIN || '';
}

export async function escalateDarkDevices(env: Env): Promise<void> {
  const cutoff = Date.now() - HEARTBEAT_STALE_MS;
  const { results } = await env.DB.prepare(
    "SELECT id FROM events WHERE status = 'active' AND escalatedAt IS NULL AND COALESCE(lastHeartbeatAt, createdAt) < ?",
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const origin = workerOrigin(env);
  for (const row of results ?? []) {
    await notifyEscalation(env, row.id, origin, 'device_dark');
  }
}

export const scheduled = async (
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  ctx.waitUntil(
    (async () => {
      // Each job under its own ceiling (see boundedJob). Order is unchanged; what changed
      // is that a hang in any one of them can no longer silently starve the rest.
      await boundedJob('escalate', () => escalateDarkDevices(env));
      // Backstop the staggered contact cascade + emergency fallback (Brief 11).
      await boundedJob('cascade', () => advanceCascades(env, workerOrigin(env)));
      // Regenerate expired coordinator links on unresolved events so the path to closure
      // never dead-ends (orphaned-event failsafe).
      await boundedJob('reissue', () => reissueExpiredLinks(env, workerOrigin(env)));
      // §3: reprompt the coordinator at 60s; at 180s declare the coordinator path failed
      // and escalate the qualified confirmer to the guardian tier.
      await boundedJob('escalation', () => runEscalation(env, workerOrigin(env)));
      // §3: once emergency is notified, a sustained feed loss closes the session with the
      // mandatory "closure is NOT safety" note.
      await boundedJob('feed_loss', () => closeFeedLostEvents(env));
      // Brief 20 §2: orphan safeguard — close any active event whose owner is gone or that
      // is open past the absolute safety ceiling, so it cannot outlive the ability to close it.
      await boundedJob('orphan', () => closeOrphanedEvents(env));
      await boundedJob('integrity', () => runIntegrityScan(env, workerOrigin(env)));
      // Brief 35 §C — TTL backstop for a canary run that died before its explicit purge.
      await boundedJob('canary_ttl', () => sweepExpiredCanaryEvents(env).then(() => undefined));
      // Brief 40 §F3 — seal every closed-and-unsealed event. On the CRON, deliberately not on
      // the integrity Durable Object: Brief 37 §D bounds that object to integrity appends and
      // event-scoped ordering, and one object must not become where everything ends up.
      // Bounded like every other job, so a slow seal cannot starve the jobs behind it.
      await boundedJob('seal', () => drainSealQueue(env, workerOrigin(env)).then(() => undefined));
      // §F7 — a closed event still unsealed past the threshold is an operator alert. Without
      // it the failure mode is the one §F exists to fix: sealing quietly not happening while
      // everything reports healthy.
      await boundedJob('seal_alert', () => alertOnUnsealed(env));
      // Brief 35 Fix B §D — drain closed alert windows. This is what makes "never dropped" true:
      // a burst that collapsed into a counter surfaces here with its count and its first and last
      // instance, so silence genuinely means nothing happened.
      await boundedJob('alert_summaries', () => drainAlertSummaries(env).then(() => undefined));
    })(),
  );
};
