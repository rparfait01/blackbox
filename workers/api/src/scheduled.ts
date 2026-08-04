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
import { drainAlertSummaries, operatorAlert } from './lib/operator-alert';
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

/**
 * Brief 55 §A2 — AN OPEN EVENT THAT HAS RECEIVED NO CAPTURE IS AN ERROR-LEVEL OPERATOR ALERT.
 *
 * A live device test produced an event that dispatched, cascaded, heartbeated, took 8 location
 * fixes and closed cleanly after 74 seconds, having stored ZERO chunks — the OS had refused the
 * page a microphone. Every existing monitor passed it: it was not dark, not orphaned, not
 * unsealed, not failing delivery. The one thing wrong with it was the only thing that mattered,
 * and nothing was watching for it.
 *
 * ═══ WHY THE GRACE PERIOD, AND WHY IT IS NOT LONGER ══════════════════════════════════════════
 *
 * The first chunk cannot exist at t=0: permission, acquisition, the first recorder timeslice and
 * the upload all have to happen. Below the threshold "no chunks" means "not yet" and alerting
 * would be noise that trains an operator to ignore this. Above it, "not yet" has stopped being a
 * plausible reading.
 *
 * 45 seconds is deliberately shorter than any of this file's other thresholds. Every other job
 * here reports a degraded event; this one reports an event with no evidence behind it at all,
 * and the window in which that can still be acted on is the window the incident is happening in.
 *
 * ═══ THIS ADDS NO LATENCY TO THE ALERT PATH (§E3) ════════════════════════════════════════════
 *
 * It runs on the cron, reads its own rows, and touches nothing the trigger, the dispatch or the
 * capture upload wait on. The alert path never asks this question; this asks it about the alert
 * path, afterwards, from outside.
 */
export const NO_CAPTURE_GRACE_MS = 45_000;

export async function alertOnEventsCapturingNothing(env: Env): Promise<void> {
  const cutoff = Date.now() - NO_CAPTURE_GRACE_MS;
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.createdAt FROM events e
      WHERE e.status = 'active'
        AND e.createdAt < ?
        AND NOT EXISTS (SELECT 1 FROM chunks_index c WHERE c.eventId = e.id)`,
  )
    .bind(cutoff)
    .all<{ id: string; createdAt: number }>();
  for (const row of results ?? []) {
    await operatorAlert(
      env,
      'event_capturing_nothing',
      `event ${row.id} has been ACTIVE for ${Math.round((Date.now() - row.createdAt) / 1000)}s and has ` +
        'stored ZERO capture chunks. The alert dispatched; the evidence does not exist. Most likely the ' +
        'device was refused microphone access (see Brief 55 §A/§C).',
    );
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
      // Brief 55 §A2 — an active event with no capture at all. Placed BEFORE the integrity and
      // seal jobs because it is about a live incident rather than a stored one.
      await boundedJob('no_capture', () => alertOnEventsCapturingNothing(env));
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
