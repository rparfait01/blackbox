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
import type { Env } from './types';

/** A heartbeat is "stale" after this long without a ping (heartbeat is every 10s). */
const HEARTBEAT_STALE_MS = 35_000;

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
      try {
        await escalateDarkDevices(env);
      } catch (error) {
        console.log(JSON.stringify({ level: 'error', job: 'escalate', detail: String(error) }));
      }
      try {
        // Backstop the staggered contact cascade + emergency fallback (Brief 11).
        await advanceCascades(env, workerOrigin(env));
      } catch (error) {
        console.log(JSON.stringify({ level: 'error', job: 'cascade', detail: String(error) }));
      }
      try {
        // Regenerate expired coordinator links on unresolved events so the path
        // to closure never dead-ends (orphaned-event failsafe).
        await reissueExpiredLinks(env, workerOrigin(env));
      } catch (error) {
        console.log(JSON.stringify({ level: 'error', job: 'reissue', detail: String(error) }));
      }
      try {
        await runIntegrityScan(env, workerOrigin(env));
      } catch (error) {
        console.log(JSON.stringify({ level: 'error', job: 'integrity', detail: String(error) }));
      }
    })(),
  );
};
