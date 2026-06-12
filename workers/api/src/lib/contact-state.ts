/**
 * Contact dashboard state (W7). Assembles the live snapshot the contact's view
 * renders: status + elapsed, latest location and a recent trail, the most recent
 * classification, recent transcript fragments, the latest audio sequence/mime
 * for progressive playback, and the locale-appropriate emergency numbers.
 *
 * Used by both GET /v1/c/:id/state (the polling/JSON path) and the server-side
 * render of GET /c/:id (the no-JS fallback), so the two never drift.
 */

import type { Env } from '../types';

const TRAIL_WINDOW_MS = 5 * 60 * 1000; // last 5 minutes of positions
const TRANSCRIPT_LIMIT = 12;

export interface EmergencyNumbers {
  police: string;
  ambulance: string;
}

export interface ContactState {
  active: boolean;
  status: string;
  startedAt: number;
  durationMs: number;
  /** Canonical tz offset of the event (UTC + offset; render-only). #C6 */
  tzOffsetMinutes: number | null;
  /** Lifecycle flags for the coordinator status banner (Fix Brief 3 R2). */
  lastHeartbeatAt: number | null;
  lostAt: number | null;
  escalatedAt: number | null;
  /** True when an active event has gone dark (escalated or client lost). */
  deviceDark: boolean;
  location: {
    lat: number;
    lon: number;
    accuracyM: number | null;
    speed: number | null;
    timestamp: number;
  } | null;
  trail: Array<{ lat: number; lon: number; timestamp: number }>;
  latestClassification: {
    threatLevel: string | null;
    matchedCategories: unknown[];
    toneIndicators: unknown[];
    summary: string | null;
    languages: unknown[];
  } | null;
  latestTranscriptFragments: Array<{ sequence: number; text: string }>;
  audio: { latestSequence: number | null; mimeType: string | null };
  /** True when the captured media is video (camera feed exists). Fix Brief 5 D5. */
  hasVideo: boolean;
  /** Frozen ORIGIN snapshot — immutable initial-contact anchor. Fix Brief 5 D1. */
  origin: OriginSnapshot | null;
  /** Latched, monotonic situation summary assembled from detected facts. D2/D3. */
  situation: Situation;
  /** Closure request the coordinator reviews (Brief 9 Phase D). */
  closure: {
    requested: boolean;
    pin: 'sat' | 'unsat' | null;
    reasonSecured: string | null;
    reasonTriggered: string | null;
  };
  emergency: EmergencyNumbers;
}

export interface OriginSnapshot {
  triggerType: string;
  dtgStart: number;
  tzOffsetMinutes: number | null;
  location: { lat: number; lon: number; accuracyM: number | null } | null;
  audioFromSeq: number | null;
  audioToSeq: number | null;
  categories: string[];
  threatLevel: string | null;
  voiceCount: number | null;
}

export interface Situation {
  /** Rule-derived threat level: the MAX ever observed (monotonic, never thrashes down). */
  threatLevel: string;
  /** Detected keyword categories with first-seen time (union; latches). */
  categories: Array<{ category: string; firstSeenAt: number }>;
  /** Acoustic indicators detected at any point (union; latches). */
  toneIndicators: string[];
  /** Whether >1 distinct voice was detected — INFERRED / low-confidence (D3). */
  multipleVoicesInferred: boolean;
  /** True once any signal has latched. */
  hasSignal: boolean;
}

const THREAT_ORDER = ['unknown', 'low', 'medium', 'high', 'critical'];

/** Best-effort IANA time zone for a locale. Defaults to the Japan pilot. */
function localeToTimeZone(locale: string | null): string {
  const tag = (locale ?? '').toLowerCase();
  if (tag.includes('-us') || tag === 'en') {
    return 'America/New_York';
  }
  if (tag.startsWith('en-gb') || tag.includes('-gb')) {
    return 'Europe/London';
  }
  return 'Asia/Tokyo';
}

/** Format an instant as local "HH:MM" for the event's locale (e.g. "18:42"). */
export function formatLocalTime(locale: string | null, nowMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: localeToTimeZone(locale),
    }).format(new Date(nowMs));
  } catch {
    // Fallback: UTC HH:MM if the runtime lacks the time-zone data.
    const d = new Date(nowMs);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/** Map a BCP-47 locale to local emergency numbers. Defaults to the Japan pilot. */
export function localeToEmergency(locale: string | null): EmergencyNumbers {
  const tag = (locale ?? '').toLowerCase();
  if (tag.startsWith('ja') || tag.includes('-jp')) {
    return { police: '110', ambulance: '119' };
  }
  if (tag.includes('-us') || tag === 'en') {
    return { police: '911', ambulance: '911' };
  }
  if (tag.startsWith('en-gb') || tag.includes('-gb')) {
    return { police: '999', ambulance: '999' };
  }
  // EU-wide fallback.
  return { police: '112', ambulance: '112' };
}

/**
 * Assemble the latched situation from all classification rows (Fix Brief 5
 * D2/D3). Latching is structural: category union keeps the FIRST-seen time, the
 * threat level is the MAX ever seen (monotonic — it can rise but never thrashes
 * down), and tone indicators union. Nothing here generates free text; the
 * dashboard renders these detected facts directly. Multiple-voice detection is
 * surfaced as INFERRED, never asserted.
 */
function buildSituation(
  rows: Array<{ threatLevel: string | null; matchedCategoriesJson: string | null; toneIndicatorsJson: string | null; timestamp: number }>,
): Situation {
  const firstSeen = new Map<string, number>();
  const tone = new Set<string>();
  let maxThreatIdx = 0;
  for (const row of rows) {
    const idx = THREAT_ORDER.indexOf(row.threatLevel ?? 'unknown');
    if (idx > maxThreatIdx) {
      maxThreatIdx = idx;
    }
    for (const m of safeParse(row.matchedCategoriesJson)) {
      const category = (m as { category?: string }).category;
      if (category && !firstSeen.has(category)) {
        firstSeen.set(category, row.timestamp);
      }
    }
    for (const t of safeParse(row.toneIndicatorsJson)) {
      if (typeof t === 'string') {
        tone.add(t);
      }
    }
  }
  const categories = [...firstSeen.entries()]
    .map(([category, firstSeenAt]) => ({ category, firstSeenAt }))
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  return {
    threatLevel: THREAT_ORDER[maxThreatIdx] ?? 'unknown',
    categories,
    toneIndicators: [...tone],
    multipleVoicesInferred: tone.has('multi-speaker'),
    hasSignal: categories.length > 0 || tone.size > 0 || maxThreatIdx > 1,
  };
}

function safeParse(json: string | null): unknown[] {
  if (!json) {
    return [];
  }
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function getContactState(env: Env, eventId: string): Promise<ContactState | null> {
  const event = await env.DB.prepare(
    'SELECT createdAt, status, closedAt, locale, tzOffsetMinutes, lastHeartbeatAt, lostAt, escalatedAt, closeRequestStatus, reasonSecured, reasonTriggered FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      createdAt: number;
      status: string;
      closedAt: number | null;
      locale: string | null;
      tzOffsetMinutes: number | null;
      lastHeartbeatAt: number | null;
      lostAt: number | null;
      escalatedAt: number | null;
      closeRequestStatus: string | null;
      reasonSecured: string | null;
      reasonTriggered: string | null;
    }>();
  if (!event) {
    return null;
  }

  const now = Date.now();
  const endRef = event.status !== 'active' && event.closedAt ? event.closedAt : now;

  const location = await env.DB.prepare(
    'SELECT lat, lon, accuracyM, speed, timestamp FROM locations_index WHERE eventId = ? ORDER BY timestamp DESC LIMIT 1',
  )
    .bind(eventId)
    .first<{
      lat: number;
      lon: number;
      accuracyM: number | null;
      speed: number | null;
      timestamp: number;
    }>();

  const trailRows = await env.DB.prepare(
    'SELECT lat, lon, timestamp FROM locations_index WHERE eventId = ? AND timestamp >= ? ORDER BY timestamp ASC',
  )
    .bind(eventId, now - TRAIL_WINDOW_MS)
    .all<{ lat: number; lon: number; timestamp: number }>();

  const classification = await env.DB.prepare(
    'SELECT threatLevel, matchedCategoriesJson, toneIndicatorsJson, summaryText, languagesJson FROM classifications_index WHERE eventId = ? ORDER BY timestamp DESC LIMIT 1',
  )
    .bind(eventId)
    .first<{
      threatLevel: string | null;
      matchedCategoriesJson: string | null;
      toneIndicatorsJson: string | null;
      summaryText: string | null;
      languagesJson: string | null;
    }>();

  const transcripts = await env.DB.prepare(
    'SELECT sequence, text FROM transcripts_index WHERE eventId = ? ORDER BY sequence DESC LIMIT ?',
  )
    .bind(eventId, TRANSCRIPT_LIMIT)
    .all<{ sequence: number; text: string }>();

  const audio = await env.DB.prepare(
    'SELECT sequence, mimeType FROM chunks_index WHERE eventId = ? ORDER BY sequence DESC LIMIT 1',
  )
    .bind(eventId)
    .first<{ sequence: number; mimeType: string }>();

  // Latched, monotonic SITUATION (Fix Brief 5 D2/D3): aggregate ALL
  // classifications. Union of categories (first-seen wins), MAX threat level
  // (never thrashes down). Inherently latching — adds/escalates only.
  const allClass = await env.DB.prepare(
    'SELECT threatLevel, matchedCategoriesJson, toneIndicatorsJson, timestamp FROM classifications_index WHERE eventId = ? ORDER BY timestamp ASC',
  )
    .bind(eventId)
    .all<{ threatLevel: string | null; matchedCategoriesJson: string | null; toneIndicatorsJson: string | null; timestamp: number }>();
  const situation = buildSituation(allClass.results ?? []);

  const originRow = await env.DB.prepare(
    'SELECT triggerType, dtgStart, tzOffsetMinutes, lat, lon, accuracyM, audioFromSeq, audioToSeq, initialCategoriesJson, initialThreatLevel, initialVoiceCount FROM event_origin WHERE eventId = ?',
  )
    .bind(eventId)
    .first<{
      triggerType: string;
      dtgStart: number;
      tzOffsetMinutes: number | null;
      lat: number | null;
      lon: number | null;
      accuracyM: number | null;
      audioFromSeq: number | null;
      audioToSeq: number | null;
      initialCategoriesJson: string | null;
      initialThreatLevel: string | null;
      initialVoiceCount: number | null;
    }>();
  const origin: OriginSnapshot | null = originRow
    ? {
        triggerType: originRow.triggerType,
        dtgStart: originRow.dtgStart,
        tzOffsetMinutes: originRow.tzOffsetMinutes,
        location:
          originRow.lat != null && originRow.lon != null
            ? { lat: originRow.lat, lon: originRow.lon, accuracyM: originRow.accuracyM }
            : null,
        audioFromSeq: originRow.audioFromSeq,
        audioToSeq: originRow.audioToSeq,
        categories: safeParse(originRow.initialCategoriesJson) as string[],
        threatLevel: originRow.initialThreatLevel,
        voiceCount: originRow.initialVoiceCount,
      }
    : null;

  const active = event.status === 'active';
  return {
    active,
    status: event.status,
    startedAt: event.createdAt,
    durationMs: Math.max(0, endRef - event.createdAt),
    tzOffsetMinutes: event.tzOffsetMinutes,
    lastHeartbeatAt: event.lastHeartbeatAt,
    lostAt: event.lostAt,
    escalatedAt: event.escalatedAt,
    deviceDark: active && (event.escalatedAt != null || event.lostAt != null),
    location: location
      ? {
          lat: location.lat,
          lon: location.lon,
          accuracyM: location.accuracyM,
          speed: location.speed,
          timestamp: location.timestamp,
        }
      : null,
    trail: trailRows.results ?? [],
    latestClassification: classification
      ? {
          threatLevel: classification.threatLevel,
          matchedCategories: safeParse(classification.matchedCategoriesJson),
          toneIndicators: safeParse(classification.toneIndicatorsJson),
          summary: classification.summaryText,
          languages: safeParse(classification.languagesJson),
        }
      : null,
    // Present latest-first for the contact (newest at top).
    latestTranscriptFragments: transcripts.results ?? [],
    audio: { latestSequence: audio?.sequence ?? null, mimeType: audio?.mimeType ?? null },
    hasVideo: (audio?.mimeType ?? '').startsWith('video/'),
    origin,
    situation,
    closure: {
      requested: event.closeRequestStatus != null,
      pin: event.closeRequestStatus === 'sat' ? 'sat' : event.closeRequestStatus === 'unsat' ? 'unsat' : null,
      reasonSecured: event.reasonSecured,
      reasonTriggered: event.reasonTriggered,
    },
    emergency: localeToEmergency(event.locale),
  };
}
