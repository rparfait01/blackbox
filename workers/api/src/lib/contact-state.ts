/**
 * Contact dashboard state (W7). Assembles the live snapshot the contact's view
 * renders: status + elapsed, latest location and a recent trail, the most recent
 * classification, recent transcript fragments, the latest audio sequence/mime
 * for progressive playback, and the locale-appropriate emergency numbers.
 *
 * Used by both GET /v1/c/:id/state (the polling/JSON path) and the server-side
 * render of GET /c/:id (the no-JS fallback), so the two never drift.
 */

import { formatDtg, THREAT_ORDER as SHARED_THREAT_ORDER } from '@blackbox/shared';
import { listCascadeContacts } from './contacts';
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
  /** Brief 49 §A — when the event closed, and the SAME DTG string the rest of the product
   *  renders. Preformatted server-side deliberately: the dashboard's poller runs as inline
   *  browser JS, and a second DTG formatter written there would be free to drift from
   *  `formatDtg` (Brief 29 §-1 — reuse, never re-implement). Null while the event is live. */
  closedAt: number | null;
  closedDtg: string | null;
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
  /**
   * Brief 50 §C — is the DEVICE transcribing? Zero fragments is ambiguous between silence, not
   * transcribing, and not yet; only the device can say which, and null means it has not said.
   */
  transcription: { state: 'active' | 'degraded' | 'unavailable' | null; detail: string | null };
  /** Frozen ORIGIN snapshot — immutable initial-contact anchor. Fix Brief 5 D1. */
  origin: OriginSnapshot | null;
  /**
   * Brief 60 — the origin DTG, preformatted server-side, for the same reason `closedDtg` is:
   * the poll renderer is inline browser JS, and a second DTG formatter written there is free to
   * drift from `formatDtg`. Reuse, never re-implement.
   */
  originDtg: string | null;
  /** Latched, monotonic situation summary assembled from detected facts. D2/D3. */
  situation: Situation;
  /**
   * Brief 56 §A2 — HOW FAR WORD OF THIS INCIDENT TRAVELLED BEFORE SOMEONE TOOK IT.
   *
   * The cascade halts on claim and always has, but where in the chain the halt landed was
   * invisible on every surface. A coordinator claiming at T+8s stops it after one contact; at
   * T+12s, after two. Both rendered identically, so neither the coordinator nor the survivor
   * could tell who else already knows — which is a question both of them actually have.
   *
   * `notifiedBeforeClaim` is null when nobody has claimed. `dispatched` keeps counting after a
   * claim only in the fail-open case (§A3), so the two can differ and are reported separately
   * rather than one being derived from the other.
   */
  cascade: { dispatched: number; total: number; notifiedBeforeClaim: number | null };
  /**
   * Brief 60 — HAS ANYONE TAKEN COORDINATION?
   *
   * The notified view renders a TAKE COORDINATION button from this, and it used to be decided
   * once at page render. A secondary contact was offered coordination on an event that had had a
   * coordinator for five minutes, because their page was a photograph. Every value this page
   * shows must be re-derivable from a poll, and this one was not exposed at all.
   */
  coordinatorClaimed: boolean;
  /** Closure request the coordinator reviews (Brief 9 Phase D). */
  closure: {
    requested: boolean;
    pin: 'sat' | 'unsat' | null;
    reasonSecured: string | null;
    reasonTriggered: string | null;
    lockout: boolean;
    /** §E3/§E4 — repeated duress escalated this event to TAMPERING. */
    tampering: boolean;
    /** §3 — current qualified confirmer tier ('coordinator' | 'guardian'). */
    tier: string;
    /** §3 — the coordinator path failed to confirm; the guardian is now the backstop. */
    coordinatorFailed: boolean;
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

/**
 * Brief 52 §D — the monotonic ranking, with `unclassified` between "no audio" and "low".
 *
 * The order is a claim about how much we KNOW, not only about severity:
 *   unknown      — no audible input at all
 *   unclassified — audible input we could not read (a missing lexicon, most often)
 *   low…critical — we read it and judged it
 *
 * `unclassified` sits ABOVE unknown because hearing something unreadable is more than hearing
 * nothing, and BELOW low because one tick we did understand outranks one we did not. Omitting it
 * was not an option: `indexOf` returns -1 for an unlisted level, which collapsed unclassified
 * silently into `unknown` — the exact erasure this section exists to stop.
 */
// Brief 55 §D — one vocabulary, defined in @blackbox/shared and read by every surface that
// renders a classification. It used to be defined here AND again in the review page, and the two
// copies disagreed about whether `unclassified` exists.
const THREAT_ORDER = SHARED_THREAT_ORDER;
/** Index of 'medium' — the point at which the level ALONE constitutes a signal. */
const MEDIUM_IDX = THREAT_ORDER.indexOf('medium');
const UNCLASSIFIED_IDX = THREAT_ORDER.indexOf('unclassified');

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

/**
 * Map an account region (the authoritative source) to local emergency numbers.
 * Returns null for an unknown/absent region so the caller can fall back to the
 * locale heuristic. The account region is preferred over the device locale
 * because the device's `navigator.language` is frequently wrong abroad (e.g. an
 * English phone used in Japan), which is exactly how the dashboard came to show
 * the EU "112" while LINE said "110" (Brief 12 P3).
 */
export function regionToEmergency(regionId: string | null): EmergencyNumbers | null {
  switch ((regionId ?? '').toLowerCase()) {
    case 'jp':
    case 'jp-47':
      return { police: '110', ambulance: '119' };
    case 'us':
      return { police: '911', ambulance: '911' };
    case 'gb':
      return { police: '999', ambulance: '999' };
    default:
      return null;
  }
}

/** Resolve emergency numbers for an event: account region first, then locale. */
export async function resolveEmergency(
  env: Env,
  userId: string | null,
  locale: string | null,
): Promise<EmergencyNumbers> {
  if (userId) {
    const user = await env.DB.prepare('SELECT regionId FROM users WHERE id = ?')
      .bind(userId)
      .first<{ regionId: string | null }>();
    const byRegion = regionToEmergency(user?.regionId ?? null);
    if (byRegion) {
      return byRegion;
    }
  }
  return localeToEmergency(locale);
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
    // §C/§D — UNCLASSIFIED IS A SIGNAL. Without it the panel falls through to "No specific
    // indicators detected yet", which reads as reassurance about audio nobody could read.
    // (`maxThreatIdx > 1` used to mean medium-and-above; it is named now so inserting a level
    // into THREAT_ORDER cannot silently change which levels count.)
    hasSignal:
      categories.length > 0 ||
      tone.size > 0 ||
      maxThreatIdx >= MEDIUM_IDX ||
      maxThreatIdx === UNCLASSIFIED_IDX,
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
    'SELECT userId, userHash, createdAt, status, closedAt, locale, tzOffsetMinutes, lastHeartbeatAt, lostAt, escalatedAt, closeRequestStatus, reasonSecured, reasonTriggered, closureLockoutAt, tamperingAt, escalationTier, coordinatorPathFailedAt, coordinatorClaimedAt, transcriptionState, transcriptionDetail, cascadeStep, cascadeStepAtClaim FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{
      userId: string | null;
      createdAt: number;
      status: string;
      closedAt: number | null;
      locale: string | null;
      tzOffsetMinutes: number | null;
      lastHeartbeatAt: number | null;
      lostAt: number | null;
      escalatedAt: number | null;
      userHash: string | null;
      cascadeStep: number | null;
      cascadeStepAtClaim: number | null;
      coordinatorClaimedAt: number | null;
      closeRequestStatus: string | null;
      tamperingAt: number | null;
      escalationTier: string | null;
      coordinatorPathFailedAt: number | null;
      reasonSecured: string | null;
      reasonTriggered: string | null;
      closureLockoutAt: number | null;
      transcriptionState: string | null;
      transcriptionDetail: string | null;
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

  // §A2 — the denominator is the SAME list the cascade actually walks, read through the same
  // helper the dispatcher uses. Deriving it from a second query would let the two drift, and a
  // count that disagrees with what was dispatched is worse than no count.
  const cascadeContacts = await listCascadeContacts(env, { userId: event.userId, userHash: event.userHash });

  const active = event.status === 'active';
  return {
    coordinatorClaimed: event.coordinatorClaimedAt != null,
    originDtg: origin ? formatDtg(origin.dtgStart) : null,
    cascade: {
      dispatched: event.cascadeStep ?? 0,
      total: cascadeContacts.length,
      notifiedBeforeClaim: event.cascadeStepAtClaim,
    },
    active,
    status: event.status,
    startedAt: event.createdAt,
    closedAt: event.closedAt,
    closedDtg: event.closedAt ? formatDtg(event.closedAt) : null,
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
    transcription: {
      state: (event.transcriptionState as 'active' | 'degraded' | 'unavailable' | null) ?? null,
      detail: event.transcriptionDetail ?? null,
    },
    origin,
    situation,
    closure: {
      requested: event.closeRequestStatus != null,
      pin: event.closeRequestStatus === 'sat' ? 'sat' : event.closeRequestStatus === 'unsat' ? 'unsat' : null,
      reasonSecured: event.reasonSecured,
      reasonTriggered: event.reasonTriggered,
      // Repeated wrong closure-pin attempts (Brief 19 §6) — surfaced so the
      // coordinator sees someone may be failing to close (possibly not the user).
      lockout: event.closureLockoutAt != null,
      tampering: event.tamperingAt != null,
      tier: event.escalationTier ?? 'coordinator',
      coordinatorFailed: event.coordinatorPathFailedAt != null,
    },
    emergency: await resolveEmergency(env, event.userId, event.locale),
  };
}
