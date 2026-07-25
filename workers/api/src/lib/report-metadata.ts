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

/** The owner's own events, newest first — so she can choose which one to report on. */
export async function listOwnEvents(env: Env, userId: string, limit = 50): Promise<ReportEventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE userId = ? ORDER BY createdAt DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<ReportEventRow>();
  return results ?? [];
}

async function getOwnEvent(env: Env, userId: string, eventId: string): Promise<ReportEventRow | null> {
  const row = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND userId = ?`)
    .bind(eventId, userId)
    .first<ReportEventRow>();
  return row ?? null;
}

export interface ReportMetadata {
  event: ReportEventRow;
  locations: Array<{ timestamp: number; lat: number; lon: number; accuracyM: number | null }>;
  deliveries: Array<{ createdAt: number; messageKind: string; channel: string; status: string }>;
  chunks: Array<{ sequence: number; sizeBytes: number; mimeType: string; createdAt: number; isFinal: number }>;
}

/** Everything the evidence zone's non-capture sections are built from, owner-scoped.
 *  Returns null when the event is not the caller's (or does not exist) — one refusal for
 *  both, so this is not an existence oracle for other accounts' events. */
export async function getReportMetadata(env: Env, userId: string, eventId: string): Promise<ReportMetadata | null> {
  const event = await getOwnEvent(env, userId, eventId);
  if (!event) return null;

  const [locations, deliveries, chunks] = await Promise.all([
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
  ]);

  return {
    event,
    locations: locations.results ?? [],
    deliveries: deliveries.results ?? [],
    chunks: chunks.results ?? [],
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
