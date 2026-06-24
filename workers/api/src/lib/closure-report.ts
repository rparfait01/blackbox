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
import { disposition, type Disposition } from './tampering';
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
}

/** Assemble + persist the write-once closure report. Idempotent per event. */
export async function buildClosureReport(
  env: Env,
  eventId: string,
): Promise<{ report: ClosureReport; packageHash: string } | null> {
  const event = await env.DB.prepare(
    'SELECT createdAt, closeRequestStatus, reasonSecured, reasonTriggered, securedAt, tamperingAt, tzOffsetMinutes FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      createdAt: number;
      closeRequestStatus: string | null;
      reasonSecured: string | null;
      reasonTriggered: string | null;
      securedAt: number | null;
      tamperingAt: number | null;
      tzOffsetMinutes: number | null;
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
  const report: ClosureReport = {
    version: 'blackbox-closure-1',
    eventId,
    generatedAt: now,
    generatedDtg: formatDtg(now),
    pin,
    duress: pin === 'unsat',
    disposition: disposition(event.closeRequestStatus, event.tamperingAt),
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
