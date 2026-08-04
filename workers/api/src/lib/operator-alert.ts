/**
 * Brief 35 Fix B §D — THE OPERATOR ALERT CHANNEL, which did not exist.
 *
 * Every brief from 33 onward specified error-level alerts and none of them named a destination.
 * They fire into `console.log` and nobody watches those. An alert nobody receives is not an alert:
 * it is the same class of defect as a verdict with no code path that produces it, and it has the
 * same effect — a control that reads as protective while protecting nothing.
 *
 * ═══ THE DESTINATION, STATED ══════════════════════════════════════════════════════════════════
 *
 * `SECURITY_CONTACT_EMAIL`, delivered through the production provider and classified as
 * alert-path traffic, so Brief 41 §C never counts it against the abuse cap and Brief 35 Fix B §A
 * never suppresses it in production. An alert that can be rate-limited away by the incident it is
 * reporting is not a channel.
 *
 * ═══ §D — RATE LIMITED, NEVER DROPPED ═════════════════════════════════════════════════════════
 *
 * SILENCE MUST MEAN NOTHING HAPPENED. That is the property, and it is why this cannot simply
 * throttle. Within a window the FIRST instance of an alert type sends immediately — an operator
 * learns about a problem in seconds, not at the end of an hour. Subsequent instances increment a
 * counter instead of sending. When the window closes, a summary reports the count with the first
 * and last instance. Nothing is discarded; the second through nine-hundredth become a number.
 *
 * The window lives in D1 rather than in an isolate because a storm arrives across many isolates,
 * and each would otherwise believe itself to be the first.
 *
 * ═══ §E3 — ALERTS IN A NON-PRODUCTION ENVIRONMENT ═════════════════════════════════════════════
 *
 * §A makes external providers unreachable from staging, which would silently swallow staging's
 * own alerts. That is stated and chosen rather than discovered: in a non-production environment
 * the alert is RECORDED and not sent. Staging alerts are readable on the readiness panel and in
 * the operator_alerts table, and no staging condition can page a human. The alternative — carving
 * an exception through §A for alerts — would be a bypass, and §E4 forbids one.
 */
import { resolveEnvironment } from './environment';
import type { Env } from '../types';

/**
 * The email module is imported DYNAMICALLY, and that is structural rather than stylistic.
 *
 * The alert channel must send mail; the mail path must consult the environment gate; the
 * environment gate must be able to raise an alert when it cannot determine the environment. That
 * is a static import cycle, and under ESM a cycle resolves to `undefined` at module-init time for
 * whichever edge is evaluated first — a channel that silently becomes a no-op depending on import
 * order. Deferring the edge to call time removes the cycle entirely, and the codebase already uses
 * this pattern where auth.ts sends a magic link.
 */

/** One window per alert type. Long enough that a storm collapses; short enough to stay current. */
export const ALERT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The alert types §D requires be retrofitted to this channel. Named as a closed set so the
 * retrofit is reviewable — an alert not on this list is an alert that still goes nowhere.
 */
export const ALERT_TYPES = [
  // §A/§B — dispatch posture
  'environment_indeterminate',
  'non_production_holds_provider_credentials',
  // Brief 35 §D/§G — suppression integrity, both directions
  'canary_flag_on_non_canary_account',
  'routable_contact_on_canary_account',
  // Brief 40 — custody
  'seal_pending_beyond_threshold',
  'vault_backlog',
  // Brief 41 — abuse
  'sustained_rate_limiting',
  'limiter_store_failed_open',
  // Brief 33 Fix A §F / Brief 35 Fix A — platform and deploy
  'request_headroom_low',
  'deploy_gate_unavailable',
  'deploy_gate_quota_exceeded',
  'storage_degraded',
  // Brief 36/37/38 — capture and chain integrity. These are error level because nothing
  // legitimate produces them once the client state machine is deployed.
  'plaintext_chunk_undeclared',
  'encryption_declaration_mismatch',
  'integrity_do_unbound',
  'terminal_claim_rejected',
  'chain_append_failed',
  'audit_write_failed',
  'delivery_record_failed',
  // Brief 55 §A2 — AN OPEN EVENT THAT HAS RECEIVED NO CAPTURE AT ALL.
  //
  // The condition the product exists to prevent, and it presented as a working alert: dispatched,
  // cascaded, heartbeating, closing normally, with zero chunks ever stored. Nothing else on this
  // list describes "the alert worked and the evidence does not exist", which is why it ran for 74
  // seconds without anyone being told.
  'event_capturing_nothing',
  // Brief 56 §A3 — the cascade could not read whether a coordinator had claimed, and DISPATCHED
  // rather than suppress. Error level because it means D1 was unreachable on the alert path and
  // the per-step double-notify guarantee was surrendered for the duration.
  'cascade_halt_check_unreadable',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

const windowStartFor = (now: number): number => Math.floor(now / ALERT_WINDOW_MS) * ALERT_WINDOW_MS;

/**
 * Raise an operator alert.
 *
 * Never throws and never awaits a provider on the caller's critical path beyond one send — call it
 * from `waitUntil` where the caller is latency-sensitive. Returns what it did, so a test can
 * assert delivery rather than assuming it.
 */
export async function operatorAlert(
  env: Env,
  alertType: AlertType,
  detail: string,
  now: number = Date.now(),
): Promise<{ sent: boolean; counted: boolean; reason: string }> {
  const windowStart = windowStartFor(now);
  const trimmed = detail.slice(0, 500);
  try {
    // Claim the window. INSERT OR IGNORE means exactly one caller across all isolates wins the
    // right to send immediately; everyone else falls through to the increment below.
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO operator_alerts (alertType, windowStart, firstAt, lastAt, count, firstDetail, lastDetail)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(alertType, windowStart, now, now, trimmed, trimmed)
      .run();

    const isFirst = (claim.meta?.changes ?? 0) > 0;
    if (!isFirst) {
      await env.DB.prepare(
        'UPDATE operator_alerts SET count = count + 1, lastAt = ?, lastDetail = ? WHERE alertType = ? AND windowStart = ?',
      )
        .bind(now, trimmed, alertType, windowStart)
        .run();
      return { sent: false, counted: true, reason: 'within an open window — counted, and reported in the summary' };
    }

    const delivered = await deliver(env, `[BLACK BOX] ${alertType}`, `${alertType}\n\n${trimmed}\n\nAt: ${new Date(now).toISOString()}`);
    if (delivered.sent) {
      await env.DB.prepare('UPDATE operator_alerts SET notifiedAt = ? WHERE alertType = ? AND windowStart = ?')
        .bind(now, alertType, windowStart)
        .run();
    }
    return delivered;
  } catch (err) {
    // An alert channel that throws takes down the thing it was reporting on.
    console.log(JSON.stringify({ level: 'error', alert: alertType, detail: trimmed, channelError: String(err).slice(0, 120) }));
    return { sent: false, counted: false, reason: 'alert store unavailable — logged only' };
  }
}

/**
 * §D — drain closed windows. Called from the cron.
 *
 * This is what makes "never dropped" true: a burst that collapsed into a counter is guaranteed to
 * surface here with its count and its first and last instance.
 */
export async function drainAlertSummaries(env: Env, now: number = Date.now()): Promise<number> {
  const cutoff = windowStartFor(now); // windows strictly before the current one are closed
  try {
    const { results } = await env.DB.prepare(
      `SELECT alertType, windowStart, firstAt, lastAt, count, firstDetail, lastDetail
       FROM operator_alerts
       WHERE summarisedAt IS NULL AND windowStart < ? AND count > 1
       ORDER BY windowStart ASC LIMIT 20`,
    )
      .bind(cutoff)
      .all<{
        alertType: string;
        windowStart: number;
        firstAt: number;
        lastAt: number;
        count: number;
        firstDetail: string | null;
        lastDetail: string | null;
      }>();

    let sent = 0;
    for (const row of results ?? []) {
      const body = [
        `${row.alertType} — ${row.count} occurrence(s) in a ${ALERT_WINDOW_MS / 60000}-minute window`,
        '',
        `FIRST  ${new Date(row.firstAt).toISOString()}`,
        `       ${row.firstDetail ?? ''}`,
        '',
        `LAST   ${new Date(row.lastAt).toISOString()}`,
        `       ${row.lastDetail ?? ''}`,
        '',
        'The first occurrence was reported immediately. This is the remainder, collapsed to a count',
        'so that a storm cannot bury the signal — none were discarded.',
      ].join('\n');
      const r = await deliver(env, `[BLACK BOX] ${row.alertType} ×${row.count}`, body);
      await env.DB.prepare('UPDATE operator_alerts SET summarisedAt = ? WHERE alertType = ? AND windowStart = ?')
        .bind(now, row.alertType, row.windowStart)
        .run();
      if (r.sent) sent += 1;
    }
    // Windows that only ever had one instance are already fully reported; close them out so the
    // owed-summary query stays small.
    await env.DB.prepare('UPDATE operator_alerts SET summarisedAt = ? WHERE summarisedAt IS NULL AND windowStart < ? AND count = 1')
      .bind(now, cutoff)
      .run();
    return sent;
  } catch {
    return 0;
  }
}

/** The destination, and the §E3 decision about non-production, in one place. */
async function deliver(env: Env, subject: string, text: string): Promise<{ sent: boolean; counted: boolean; reason: string }> {
  const to = (env.SECURITY_CONTACT_EMAIL ?? '').trim();
  if (!to) {
    console.log(JSON.stringify({ level: 'error', alert: 'no_alert_destination', subject }));
    return { sent: false, counted: false, reason: 'SECURITY_CONTACT_EMAIL is not set — nowhere to send' };
  }
  const identity = await resolveEnvironment(env);
  if (identity.verdict === 'NON_PRODUCTION') {
    // §E3, chosen deliberately: recorded, not sent. No staging condition can page a human, and
    // carving an exception through §A for alerts would be exactly the bypass §E4 forbids.
    console.log(JSON.stringify({ level: 'warn', alert: 'recorded_not_sent', environment: identity.name, subject }));
    return { sent: false, counted: true, reason: `recorded only — ${identity.name} does not reach external providers (§E3)` };
  }
  // 'alert' classification: Brief 41 §C never counts this against the abuse cap, and §A never
  // suppresses it in production.
  const { sendEmail } = await import('../channels/sendgrid-email');
  const r = await sendEmail(env, { to, subject, html: `<pre>${escapeHtml(text)}</pre>`, text }, 'alert');
  return { sent: r.ok === true, counted: true, reason: r.ok ? 'delivered' : `provider refused: ${r.body?.slice?.(0, 80) ?? ''}` };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
