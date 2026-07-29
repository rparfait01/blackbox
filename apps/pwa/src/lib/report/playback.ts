/**
 * Evidence playback — the read side of the survivor's own capture, assembled on her device
 * so she can watch or listen to what was recorded.
 *
 * THIS IS A REVIEW PATH, NOT A REPORT PATH. It produces nothing signed, nothing exportable,
 * and nothing that leaves the device: a Blob URL that lives until the screen is closed. The
 * certified report (generate.ts) is the artifact she can hand to a court; this is her looking
 * at her own material.
 *
 * IT REUSES, IT DOES NOT RE-IMPLEMENT. The same owner-scoped endpoints the certified report
 * uses, the same envelope decryptor, the same commitment check. The server hands over
 * ciphertext and the commitments it recorded before encryption; it holds no key that could
 * open either, so a review is something only she can perform (Brief 26 §0).
 *
 * AVAILABILITY OUTRANKS UNIFORMITY, exactly as on the write path. A capture may legitimately
 * contain plaintext chunks (the upload path fails open rather than dropping a survivor's
 * recording), and a capture may have no envelope at all. Neither is a reason to refuse a
 * review — we play what we can open and say plainly what we could not.
 */
import { API_BASE_URL, envelopeEncryptionEnabled } from '@/lib/env';
import { api } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { decryptStoredChunk, openCaptureDek, verifyChunkCommitment } from '@/lib/crypto/capture-decryptor';
import { getStoredEnvelopeKeypair } from '@/lib/storage/user-config';
import { isoUtc, type ChunkIndexEntry, type Commitment } from './evidence';
import { listReportableEvents, type ReportEventSummary } from './generate';

/** The review list is the same owner-scoped event list the certified report picks from —
 *  one endpoint, one meaning of "my records". */
export { listReportableEvents as listReviewableEvents };
export type { ReportEventSummary as ReviewEventSummary };

/** What we could establish about one recorded segment. `openable: false` means the bytes
 *  are present but could not be opened — reported, never hidden. */
export interface ReviewSegment {
  sequence: number;
  recordedAt: string;
  bytes: number;
  openable: boolean;
  wasEncrypted: boolean;
  /** null when no capture-time commitment exists for this segment to check against. */
  commitmentVerified: boolean | null;
}

export interface ReviewMedia {
  /** Object URL for the assembled recording. The caller MUST revoke it (see revokeReview). */
  url: string;
  mimeType: string;
  kind: 'video' | 'audio';
}

export type ReviewFailure =
  | 'disabled' // zero-knowledge custody is off — there is no review path
  | 'no_key' // this device holds no envelope private key, so her capture cannot be opened here
  | 'no_event' // not the caller's event, or gone
  | 'no_capture' // the event has no recorded segments
  | 'unopenable' // segments exist but not one of them could be opened
  | 'network';

export interface ReviewCapture {
  eventId: string;
  media: ReviewMedia;
  segments: ReviewSegment[];
  /** Counts, stated rather than implied — a review that quietly drops material is a lie. */
  segmentsOpened: number;
  segmentsUnopenable: number;
  segmentsMissing: number;
  segmentsVerified: number;
  segmentsFailedCheck: number;
  totalBytes: number;
}

export type ReviewResult = { ok: true; capture: ReviewCapture } | { ok: false; reason: ReviewFailure };

interface MetadataResponse {
  metadata: { chunks: ChunkIndexEntry[] };
}
interface EnvelopeResponse {
  envelope: { wrappedDek: string; algId: string; commitments: Commitment[] } | null;
}

/** Fetch one stored (still-encrypted) segment. Raw fetch, not the JSON helper — these are
 *  bytes. Identical route and shape to the certified report's fetch, deliberately. */
async function fetchSegmentBytes(eventId: string, sequence: number): Promise<Uint8Array | null> {
  const token = getSessionToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/me/reports/events/${eventId}/chunks/${sequence}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** MediaRecorder timeslices concatenate back into the original stream when kept in
 *  sequence order — order is the whole meaning here, so it is enforced, never assumed. */
function assemble(parts: Uint8Array[], mimeType: string): ReviewMedia {
  const blob = new Blob(parts as BlobPart[], { type: mimeType });
  return {
    url: URL.createObjectURL(blob),
    mimeType,
    kind: mimeType.startsWith('video') ? 'video' : 'audio',
  };
}

/**
 * Open one event's capture for review, on this device.
 *
 * A segment that will not decrypt is an integrity signal, so it is REPORTED as unopenable —
 * but its bytes are kept out of the assembled stream, because splicing undecodable bytes
 * into the middle of a recording would break the parts that are perfectly good. She sees
 * everything that can be played, plus an honest count of what could not.
 */
export async function openCaptureForReview(eventId: string): Promise<ReviewResult> {
  if (!envelopeEncryptionEnabled) {
    return { ok: false, reason: 'disabled' };
  }

  const metaRes = await api<MetadataResponse>(`/v1/me/reports/events/${eventId}/metadata`);
  if (metaRes.status === 0) return { ok: false, reason: 'network' };
  if (!metaRes.ok || !metaRes.data) return { ok: false, reason: 'no_event' };
  const index = [...metaRes.data.metadata.chunks].sort((a, b) => a.sequence - b.sequence);
  if (index.length === 0) return { ok: false, reason: 'no_capture' };

  const envRes = await api<EnvelopeResponse>(`/v1/me/events/${eventId}/envelope`);
  if (envRes.status === 0) return { ok: false, reason: 'network' };
  const envelope = envRes.data?.envelope ?? null;

  // No envelope → the capture was stored plaintext (a write-path fail-open). That is still
  // her recording and she is still entitled to watch it; only an ENCRYPTED capture needs a key.
  let dek: CryptoKey | null = null;
  if (envelope) {
    const keypair = await getStoredEnvelopeKeypair();
    if (!keypair?.privateKey) {
      return { ok: false, reason: 'no_key' };
    }
    try {
      dek = await openCaptureDek(envelope.wrappedDek, keypair.privateKey);
    } catch {
      // The wrapped key will not open with the key this device holds — a different device
      // sealed it. Say that plainly rather than showing an empty player.
      return { ok: false, reason: 'no_key' };
    }
  }
  const commitmentFor = new Map((envelope?.commitments ?? []).map((c) => [c.sequence, c.plaintextHash]));

  const parts: Uint8Array[] = [];
  const segments: ReviewSegment[] = [];
  let missing = 0;
  let unopenable = 0;
  let verified = 0;
  let failedCheck = 0;
  let totalBytes = 0;

  for (const entry of index) {
    const framed = await fetchSegmentBytes(eventId, entry.sequence);
    if (!framed) {
      missing += 1;
      continue;
    }
    const commitment = commitmentFor.get(entry.sequence) ?? null;
    let openable = true;
    let wasEncrypted = false;
    let commitmentVerified: boolean | null = null;

    try {
      const opened = dek
        ? await decryptStoredChunk({
            dek,
            framed,
            captureId: eventId,
            sequence: entry.sequence,
            isFinal: entry.isFinal === 1,
          })
        : { plaintext: framed, wasEncrypted: false };
      wasEncrypted = opened.wasEncrypted;
      if (commitment) {
        commitmentVerified = await verifyChunkCommitment(opened.plaintext, commitment);
      }
      parts.push(opened.plaintext);
      totalBytes += opened.plaintext.byteLength;
    } catch {
      openable = false;
      wasEncrypted = true;
      commitmentVerified = commitment ? false : null;
    }

    if (!openable) unopenable += 1;
    if (commitmentVerified === true) verified += 1;
    if (commitmentVerified === false) failedCheck += 1;
    segments.push({
      sequence: entry.sequence,
      recordedAt: isoUtc(entry.createdAt),
      bytes: entry.sizeBytes,
      openable,
      wasEncrypted,
      commitmentVerified,
    });
  }

  if (parts.length === 0) {
    return { ok: false, reason: unopenable > 0 ? 'unopenable' : 'no_capture' };
  }

  return {
    ok: true,
    capture: {
      eventId,
      media: assemble(parts, index[0].mimeType || 'video/mp4'),
      segments,
      segmentsOpened: parts.length,
      segmentsUnopenable: unopenable,
      segmentsMissing: missing,
      segmentsVerified: verified,
      segmentsFailedCheck: failedCheck,
      totalBytes,
    },
  };
}

/** Release the assembled recording. Called on close/unmount so a review leaves nothing
 *  resident — the bytes were only ever in this tab's memory. */
export function revokeReview(capture: ReviewCapture | null): void {
  if (capture) {
    URL.revokeObjectURL(capture.media.url);
  }
}
