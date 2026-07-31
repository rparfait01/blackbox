/**
 * Report source data (Brief 29 §1) — OWNER-SCOPED reads, for the survivor's own device.
 *
 * Every function here takes the caller's userId and refuses anything that is not theirs.
 * A report is hers: the org and the operator are never in this path and no route here
 * crosses an account boundary (§5).
 *
 * These are READS of rows that already exist. Nothing here writes, and nothing on the
 * capture, dispatch, or closure paths calls into this module — it is additive surface for
 * a survivor assembling her own record, gated on zero-knowledge custody being armed.
 *
 * The server hands over CIPHERTEXT and the commitments it recorded at capture time. It
 * never decrypts, and holds no key that could: the plaintext summary is assembled on her
 * device, by her key (§0).
 */
import type { Env } from '../types';

export interface ReportEventRow {
  eventId: string;
  createdAt: number;
  closedAt: number | null;
  status: string;
  closedBy: string | null;
  tzOffsetMinutes: number | null;
  coordinatorClaimedAt: number | null;
  escalatedAt: number | null;
  escalationTier: string | null;
  securedAt: number | null;
}

const EVENT_COLUMNS =
  'id AS eventId, createdAt, closedAt, status, closedBy, tzOffsetMinutes, coordinatorClaimedAt, escalatedAt, escalationTier, securedAt';

/**
 * The owner's own events, newest first — so she can choose which one to report on.
 * `isTest = 0` (Brief 35 §C): a deploy canary event is not evidence and must never be
 * offerable as the subject of a certified report.
 */
export async function listOwnEvents(env: Env, userId: string, limit = 50): Promise<ReportEventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE userId = ? AND isTest = 0 ORDER BY createdAt DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<ReportEventRow>();
  return results ?? [];
}

async function getOwnEvent(env: Env, userId: string, eventId: string): Promise<ReportEventRow | null> {
  const row = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND userId = ? AND isTest = 0`)
    .bind(eventId, userId)
    .first<ReportEventRow>();
  return row ?? null;
}

/**
 * One classifier observation, as it was recorded DURING the event. This is a replay of
 * `classifications_index`, not a re-analysis: nothing here is recomputed at read time,
 * so re-opening a review always shows identical values.
 *
 * `matchedCategories` and `toneIndicators` are parsed from the stored JSON so the
 * client renders a typed shape rather than re-implementing tolerant parsing. Parsing
 * is DEFENSIVE — a malformed or legacy value degrades to an empty array and never
 * throws, because a survivor must never be locked out of her own evidence by one bad
 * row written months ago.
 */
export interface ReportClassification {
  timestamp: number;
  threatLevel: string | null;
  /** Categories that actually fired, with the dictionary entries that matched. */
  matchedCategories: Array<{ category: string; matches: string[]; weight: number }>;
  /** Acoustic signals the tone analyzer surfaced (e.g. 'whisper', 'multi-speaker'). */
  toneIndicators: string[];
  /** The template-generated factual line written at capture. Never a model judgement. */
  summaryText: string | null;
  languages: string[];
}

export interface ReportTranscript {
  sequence: number;
  text: string;
  isFinal: number;
  createdAt: number;
}

export interface ReportMetadata {
  event: ReportEventRow;
  locations: Array<{ timestamp: number; lat: number; lon: number; accuracyM: number | null }>;
  deliveries: Array<{ createdAt: number; messageKind: string; channel: string; status: string }>;
  chunks: Array<{ sequence: number; sizeBytes: number; mimeType: string; createdAt: number; isFinal: number }>;
  /**
   * NOTE ON CUSTODY — these two collections are SERVER-READABLE PLAINTEXT, and that is
   * pre-existing, not introduced here. Zero-knowledge custody (Brief 26) encrypts capture
   * MEDIA: chunks are wrapped per-capture and served as ciphertext the server cannot open.
   * Transcript fragments and classifier output, by contrast, have always been written to
   * D1 in the clear by POST /v1/events/:id/{transcripts,classifications} — the coordinator
   * dispatch path reads them to build situational awareness.
   *
   * So serving them here grants the OWNER access to rows the server already holds; it does
   * not weaken the envelope. It does mean the survivor's own words are not protected to the
   * same standard as her recording. That gap is real and named in the session report as a
   * follow-up brief (seal transcripts under the same envelope), not papered over here.
   */
  classifications: ReportClassification[];
  transcripts: ReportTranscript[];
}

/** Parse a stored JSON column into an array, degrading to [] rather than throwing.
 *  Never let one malformed legacy row deny a survivor her whole event. */
function parseArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Everything the evidence zone's non-capture sections are built from, owner-scoped.
 *  Returns null when the event is not the caller's (or does not exist) — one refusal for
 *  both, so this is not an existence oracle for other accounts' events. */
export async function getReportMetadata(env: Env, userId: string, eventId: string): Promise<ReportMetadata | null> {
  const event = await getOwnEvent(env, userId, eventId);
  if (!event) return null;

  const [locations, deliveries, chunks, classifications, transcripts] = await Promise.all([
    env.DB.prepare('SELECT timestamp, lat, lon, accuracyM FROM locations_index WHERE eventId = ? ORDER BY timestamp')
      .bind(eventId)
      .all<{ timestamp: number; lat: number; lon: number; accuracyM: number | null }>(),
    env.DB.prepare(
      'SELECT createdAt, messageKind, channel, status FROM delivery_records WHERE eventId = ? ORDER BY createdAt',
    )
      .bind(eventId)
      .all<{ createdAt: number; messageKind: string; channel: string; status: string }>(),
    env.DB.prepare(
      'SELECT sequence, sizeBytes, mimeType, createdAt, isFinal FROM chunks_index WHERE eventId = ? ORDER BY sequence',
    )
      .bind(eventId)
      .all<{ sequence: number; sizeBytes: number; mimeType: string; createdAt: number; isFinal: number }>(),
    // Chronological: the summary panel replays these in the order they were observed,
    // so the survivor sees the record develop as the incident did.
    env.DB.prepare(
      'SELECT timestamp, threatLevel, matchedCategoriesJson, toneIndicatorsJson, summaryText, languagesJson FROM classifications_index WHERE eventId = ? ORDER BY timestamp',
    )
      .bind(eventId)
      .all<{
        timestamp: number;
        threatLevel: string | null;
        matchedCategoriesJson: string | null;
        toneIndicatorsJson: string | null;
        summaryText: string | null;
        languagesJson: string | null;
      }>(),
    env.DB.prepare('SELECT sequence, text, isFinal, createdAt FROM transcripts_index WHERE eventId = ? ORDER BY sequence')
      .bind(eventId)
      .all<ReportTranscript>(),
  ]);

  return {
    event,
    locations: locations.results ?? [],
    deliveries: deliveries.results ?? [],
    chunks: chunks.results ?? [],
    classifications: (classifications.results ?? []).map((r) => ({
      timestamp: r.timestamp,
      threatLevel: r.threatLevel,
      matchedCategories: parseArray<{ category: string; matches: string[]; weight: number }>(r.matchedCategoriesJson),
      toneIndicators: parseArray<string>(r.toneIndicatorsJson),
      summaryText: r.summaryText,
      languages: parseArray<string>(r.languagesJson),
    })),
    transcripts: transcripts.results ?? [],
  };
}

/** One stored chunk's bytes — still ENCRYPTED; the server cannot open it. Owner-scoped:
 *  the ownership check is on the event, before the R2 key is even looked up. */
export async function getOwnChunkBytes(
  env: Env,
  userId: string,
  eventId: string,
  sequence: number,
): Promise<ArrayBuffer | null> {
  const owned = await getOwnEvent(env, userId, eventId);
  if (!owned) return null;
  const row = await env.DB.prepare('SELECT r2Key FROM chunks_index WHERE eventId = ? AND sequence = ?')
    .bind(eventId, sequence)
    .first<{ r2Key: string }>();
  if (!row) return null;
  const object = await env.MEDIA.get(row.r2Key);
  if (!object) return null;
  return object.arrayBuffer();
}
