/**
 * Closure status report (Brief 9 Phase E — the LT7 item). Every secured session
 * generates a WRITE-ONCE report: situational summary, frozen origin snapshot,
 * location/audio custody + timestamps, PIN sat/unsat, reason triggered, reason
 * secured. It is the artifact the coordinator reviews and is included in the
 * closure notification. Canonical UTC + offset (#C6).
 */

import { formatDtg } from '@blackbox/shared';
import { getChainHead, hashString } from './integrity';
import { getContactState } from './contact-state';
import { disposition, FEED_LOST_NOTE, type Disposition } from './tampering';
import type { Env } from '../types';

export interface ClosureReport {
  version: string;
  eventId: string;
  generatedAt: number;
  generatedDtg: string;
  pin: 'sat' | 'unsat' | 'unknown';
  duress: boolean;
  /** §E4 — the authoritative disposition recorded in the report. */
  disposition: Disposition;
  /** §3 — a mandatory verbatim note for a feed-loss close; null otherwise. */
  note: string | null;
  reasonTriggered: string | null;
  reasonSecured: string | null;
  origin: unknown;
  situation: unknown;
  custody: {
    startedAt: number;
    securedAt: number;
    audioChunks: number;
    locationFixes: number;
    integrityHead: string | null;
  };
  /**
   * Brief 56 §A2 — HOW FAR WORD OF THIS INCIDENT TRAVELLED.
   *
   * The cascade halts the moment a coordinator claims. Where in the chain that halt landed was
   * recorded nowhere a survivor could read, and it is a question she has: who else knows. A live
   * device test measured claim latency at 6.6-13.9s against a second contact dispatched at T+10s,
   * so whether one person or two heard about her incident was decided inside a few hundred
   * milliseconds — and then never written down.
   *
   * `notifiedBeforeClaim` is null when nobody ever claimed, which is a different fact from zero.
   */
  cascade: {
    contactsNotified: number;
    contactsTotal: number;
    notifiedBeforeClaim: number | null;
  };
  /**
   * Brief 59 — WHAT THE EVENT COST THE PHONE.
   *
   * Two readings and a duration, from which a rate falls out. Null is the NORMAL case, never 0:
   * Firefox and every iOS browser have no battery API, and a stored null means not reported.
   * `perHourPct` is only computed when both readings exist AND the level fell — a charging phone
   * produces a meaningless or negative rate, and reporting one would be inventing the number this
   * instrument was built to stop inventing.
   */
  battery: {
    atTriggerPct: number | null;
    atClosePct: number | null;
    chargingAtTrigger: boolean | null;
    perHourPct: number | null;
  };
}

/** Assemble + persist the write-once closure report. Idempotent per event. */
export async function buildClosureReport(
  env: Env,
  eventId: string,
): Promise<{ report: ClosureReport; packageHash: string } | null> {
  const event = await env.DB.prepare(
    'SELECT createdAt, closeRequestStatus, reasonSecured, reasonTriggered, securedAt, tamperingAt, feedLostAt, tzOffsetMinutes, batteryAtTrigger, batteryAtClose, batteryChargingAtTrigger FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      createdAt: number;
      closeRequestStatus: string | null;
      reasonSecured: string | null;
      reasonTriggered: string | null;
      securedAt: number | null;
      tamperingAt: number | null;
      feedLostAt: number | null;
      tzOffsetMinutes: number | null;
      batteryAtTrigger: number | null;
      batteryAtClose: number | null;
      batteryChargingAtTrigger: number | null;
    }>();
  if (!event) {
    return null;
  }
  const state = await getContactState(env, eventId);
  const chunks = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks_index WHERE eventId = ?')
    .bind(eventId)
    .first<{ n: number }>();
  const locs = await env.DB.prepare('SELECT COUNT(*) AS n FROM locations_index WHERE eventId = ?')
    .bind(eventId)
    .first<{ n: number }>();
  const head = await getChainHead(env, eventId);
  const now = Date.now();

  const pin: ClosureReport['pin'] =
    event.closeRequestStatus === 'sat' ? 'sat' : event.closeRequestStatus === 'unsat' ? 'unsat' : 'unknown';
  const disp = disposition(event.closeRequestStatus, event.tamperingAt, event.feedLostAt);
  const durationHours = Math.max(0, now - event.createdAt) / 3_600_000;
  const bTrig = event.batteryAtTrigger;
  const bClose = event.batteryAtClose;
  const drained = bTrig != null && bClose != null && bClose < bTrig;
  const report: ClosureReport = {
    version: 'blackbox-closure-1',
    battery: {
      atTriggerPct: bTrig == null ? null : Math.round(bTrig * 100),
      atClosePct: bClose == null ? null : Math.round(bClose * 100),
      chargingAtTrigger: event.batteryChargingAtTrigger == null ? null : event.batteryChargingAtTrigger === 1,
      // Only when it actually fell, and only over a duration long enough for the arithmetic to
      // mean anything. A 40-second event extrapolated to an hour is a number with a decimal point
      // and no information in it.
      perHourPct:
        drained && durationHours >= 1 / 60
          ? Math.round(((bTrig - bClose) * 100) / durationHours)
          : null,
    },
    cascade: {
      contactsNotified: state?.cascade.dispatched ?? 0,
      contactsTotal: state?.cascade.total ?? 0,
      notifiedBeforeClaim: state?.cascade.notifiedBeforeClaim ?? null,
    },
    eventId,
    generatedAt: now,
    generatedDtg: formatDtg(now),
    pin,
    duress: pin === 'unsat',
    disposition: disp,
    note: disp === 'FEED_LOST' ? FEED_LOST_NOTE : null,
    reasonTriggered: event.reasonTriggered,
    reasonSecured: event.reasonSecured,
    origin: state?.origin ?? null,
    situation: state?.situation ?? null,
    custody: {
      startedAt: event.createdAt,
      securedAt: event.securedAt ?? now,
      audioChunks: chunks?.n ?? 0,
      locationFixes: locs?.n ?? 0,
      integrityHead: head?.chainHead ?? null,
    },
  };
  const reportJson = JSON.stringify(report);
  const packageHash = await hashString(reportJson);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO closure_reports (eventId, reportJson, packageHash, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(eventId, reportJson, packageHash, now, event.tzOffsetMinutes)
    .run();
  return { report, packageHash };
}

export async function getClosureReport(env: Env, eventId: string): Promise<ClosureReport | null> {
  const row = await env.DB.prepare('SELECT reportJson FROM closure_reports WHERE eventId = ?')
    .bind(eventId)
    .first<{ reportJson: string }>();
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.reportJson) as ClosureReport;
  } catch {
    return null;
  }
}
