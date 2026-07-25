/**
 * The evidence zone (Brief 29 §1) — the SIGNED half of a certified report.
 *
 * Two rules govern everything in this file:
 *
 *   1. DETERMINISTIC. Every field is either a system-recorded fact or an arithmetic
 *      derivation of one. No model writes a fact about the incident, no heuristic grades
 *      it, no summariser paraphrases it (§1 [A], Brief 27 §3 — absolute here). Given the
 *      same inputs this produces byte-identical output, which is what makes the signature
 *      reproducible by a third party.
 *
 *   2. ON-DEVICE. The capture summary is built by decrypting the survivor's own chunks
 *      with the survivor's own key, locally. The server hands over ciphertext and the
 *      commitments it recorded at capture time; it never sees a byte of plaintext and
 *      holds no key that could produce one. That is the zero-knowledge line (§0).
 *
 * WHAT THE CAPTURE SUMMARY IS, AND IS NOT. It is a timestamped, chunked structural record:
 * per chunk, its sequence, when it was recorded, its size, whether it was encrypted, and —
 * the load-bearing fact — whether the decrypted bytes hash to the commitment the server
 * recorded BEFORE encryption. It is NOT a transcription and NOT an interpretation. BLACK
 * BOX does not tell a court what is on the recording; it attests to the recording's
 * structure and integrity, and hands the court the recording.
 *
 * `generatedAt` and every clock value are INPUTS, never read from the ambient clock here,
 * so the builder is pure and the output is testable.
 */
import { EVIDENCE_FORMAT_VERSION, type CaptureEvidence, type ChunkEvidence, type EvidenceZone } from '@blackbox/shared';
import { decryptStoredChunk, openCaptureDek, verifyChunkCommitment } from '@/lib/crypto/capture-decryptor';
import { canonicalHash } from './canonical';

export { EVIDENCE_FORMAT_VERSION };
export type { CaptureEvidence, ChunkEvidence, EvidenceZone };

/** UTC ISO-8601 with millisecond precision — one time format across the document, so a
 *  reader never has to guess a timezone and the canonical bytes never depend on a locale. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

export interface EventMetadata {
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

export interface LocationPoint {
  timestamp: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface DeliveryRecord {
  createdAt: number;
  messageKind: string;
  channel: string;
  status: string;
}

export interface ChunkIndexEntry {
  sequence: number;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
  isFinal: number;
}

export interface Commitment {
  sequence: number;
  plaintextHash: string;
}

/** The commitment list, canonically hashed. Ordered by sequence — order is part of the
 *  meaning, so it is fixed here rather than left to whatever order the rows arrived in. */
export async function commitmentsHash(commitments: Commitment[]): Promise<string> {
  const ordered = [...commitments]
    .sort((a, b) => a.sequence - b.sequence)
    .map((c) => ({ plaintextHash: c.plaintextHash, sequence: c.sequence }));
  return canonicalHash(ordered);
}

export interface CaptureSource {
  /** The capture id the AAD was bound to at encrypt time. The capture path uses the
   *  eventId (upload-manager: makeEncryptor(dek, eventId, ivPrefix)), so this must be the
   *  eventId — a wrong value makes every chunk fail its tag. */
  eventId: string;
  /** The survivor's wrapped DEK, from GET /v1/me/events/:id/envelope. */
  wrappedDekJson: string;
  /** The survivor's OWN private key — device-custodied, never sent anywhere. */
  privateKeyB64: string;
  commitments: Commitment[];
  index: ChunkIndexEntry[];
  /** Fetch one stored (ciphertext) chunk. Returns null when the object is missing. */
  fetchChunk: (sequence: number) => Promise<Uint8Array | null>;
}

/**
 * Build the capture half of the evidence zone by decrypting on-device.
 *
 * A chunk that cannot be fetched is omitted (it is not part of the record we hold); a chunk
 * that decrypts but fails its commitment is INCLUDED and marked failed. We never quietly
 * drop a chunk that disagrees with its commitment — that disagreement is exactly the kind
 * of fact a certified report exists to surface.
 */
export async function buildCaptureEvidence(source: CaptureSource): Promise<CaptureEvidence> {
  const dek = await openCaptureDek(source.wrappedDekJson, source.privateKeyB64);
  const bySequence = new Map(source.commitments.map((c) => [c.sequence, c.plaintextHash]));
  const ordered = [...source.index].sort((a, b) => a.sequence - b.sequence);

  const chunks: ChunkEvidence[] = [];
  let totalBytes = 0;
  let verified = 0;
  let failed = 0;

  for (const entry of ordered) {
    const framed = await source.fetchChunk(entry.sequence);
    if (!framed) continue;
    const isFinal = entry.isFinal === 1;

    let wasEncrypted = false;
    let commitmentVerified: boolean | null = null;
    const commitment = bySequence.get(entry.sequence) ?? null;

    try {
      const decrypted = await decryptStoredChunk({
        dek,
        framed,
        captureId: source.eventId,
        sequence: entry.sequence,
        isFinal,
      });
      wasEncrypted = decrypted.wasEncrypted;
      if (commitment) {
        commitmentVerified = await verifyChunkCommitment(decrypted.plaintext, commitment);
      }
    } catch {
      // A frame that will not decrypt (wrong position, tamper, wrong key) is an integrity
      // signal, not a reason to omit the chunk. Record it as failed and keep going.
      commitmentVerified = commitment ? false : null;
      wasEncrypted = true;
    }

    if (commitmentVerified === true) verified += 1;
    if (commitmentVerified === false) failed += 1;
    totalBytes += entry.sizeBytes;
    chunks.push({
      sequence: entry.sequence,
      recordedAt: isoUtc(entry.createdAt),
      bytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      isFinal,
      wasEncrypted,
      commitment,
      commitmentVerified,
    });
  }

  return {
    included: true,
    chunkCount: chunks.length,
    totalBytes,
    firstChunkAt: chunks.length ? chunks[0].recordedAt : null,
    lastChunkAt: chunks.length ? chunks[chunks.length - 1].recordedAt : null,
    finalChunkPresent: chunks.some((c) => c.isFinal),
    chunksVerified: verified,
    chunksFailed: failed,
    chunks,
  };
}

/** The capture section when the survivor did not include her capture in this report. */
export function emptyCaptureEvidence(): CaptureEvidence {
  return {
    included: false,
    chunkCount: 0,
    totalBytes: 0,
    firstChunkAt: null,
    lastChunkAt: null,
    finalChunkPresent: false,
    chunksVerified: 0,
    chunksFailed: 0,
    chunks: [],
  };
}

export interface EvidenceInput {
  generatedAt: number;
  event: EventMetadata;
  /** Each section is opt-in PER REPORT (§1 [A]) — nothing is populated until she asks. */
  includeLocation: boolean;
  includeNotifications: boolean;
  locations: LocationPoint[];
  deliveries: DeliveryRecord[];
  capture: CaptureEvidence;
  commitments: Commitment[];
  algorithm: string;
}

/** Assemble the evidence zone. Pure: same inputs → identical bytes → reproducible hash. */
export async function buildEvidenceZone(input: EvidenceInput): Promise<EvidenceZone> {
  const { event } = input;
  return {
    formatVersion: EVIDENCE_FORMAT_VERSION,
    generatedAt: isoUtc(input.generatedAt),
    event: {
      eventId: event.eventId,
      openedAt: isoUtc(event.createdAt),
      closedAt: event.closedAt === null ? null : isoUtc(event.closedAt),
      durationMs: event.closedAt === null ? null : event.closedAt - event.createdAt,
      status: event.status,
      closedBy: event.closedBy,
      tzOffsetMinutes: event.tzOffsetMinutes,
      coordinatorEngagedAt: event.coordinatorClaimedAt === null ? null : isoUtc(event.coordinatorClaimedAt),
      securedAt: event.securedAt === null ? null : isoUtc(event.securedAt),
      escalatedAt: event.escalatedAt === null ? null : isoUtc(event.escalatedAt),
      escalationTier: event.escalationTier,
    },
    location: {
      included: input.includeLocation,
      pointCount: input.includeLocation ? input.locations.length : 0,
      points: input.includeLocation
        ? [...input.locations]
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((p) => ({ at: isoUtc(p.timestamp), lat: p.lat, lon: p.lon, accuracyM: p.accuracyM }))
        : [],
    },
    notifications: {
      included: input.includeNotifications,
      count: input.includeNotifications ? input.deliveries.length : 0,
      records: input.includeNotifications
        ? [...input.deliveries]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((d) => ({ at: isoUtc(d.createdAt), kind: d.messageKind, channel: d.channel, status: d.status }))
        : [],
    },
    capture: input.capture,
    custody: {
      commitmentCount: input.commitments.length,
      commitmentsHash: await commitmentsHash(input.commitments),
      algorithm: input.algorithm,
    },
  };
}
