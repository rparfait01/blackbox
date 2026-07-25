/**
 * Report generation (Brief 29 §1) — the orchestration, kept out of the component so the
 * whole pipeline is testable without a DOM.
 *
 * THE ORDER MATTERS AND IS THE POINT:
 *
 *   1. She taps. Nothing here runs before that (§1.1).
 *   2. Generic details are fetched — only for the sections she opted into (§1 [A]).
 *   3. Her capture is decrypted ON HER DEVICE with HER key. The server hands over
 *      ciphertext and the commitments it recorded at capture time; it never sees plaintext
 *      and holds no key that could produce it (§1.3).
 *   4. The evidence zone is hashed locally, and only the HASHES are sent for signature.
 *      The document's content never leaves the device to be signed (§2).
 *   5. Her statement is added afterwards, outside every signed byte (§0).
 *
 * The org and the operator are never in this path (§5): every endpoint used here is scoped
 * to the caller's own events, and there is no route that hands a report to anyone else.
 */
import { API_BASE_URL, envelopeEncryptionEnabled } from '@/lib/env';
import { getSessionToken } from '@/lib/auth';
import { api } from '@/lib/api';
import { ENVELOPE_ALG } from '@/lib/crypto/envelope';
import { getStoredEnvelopeKeypair } from '@/lib/storage/user-config';
import {
  computeEvidenceHashes,
  renderReportHtml,
  type CertifiedReportPayload,
  type EvidenceZone,
  type SignedAttestation,
} from '@blackbox/shared';
import {
  buildCaptureEvidence,
  buildEvidenceZone,
  emptyCaptureEvidence,
  type ChunkIndexEntry,
  type Commitment,
  type DeliveryRecord,
  type EventMetadata,
  type LocationPoint,
} from './evidence';

export interface ReportEventSummary {
  eventId: string;
  createdAt: number;
  closedAt: number | null;
  status: string;
}

/** Everything that can go wrong, named — so the UI can say something true rather than
 *  "something went wrong". A report that cannot be honestly certified is not certified. */
export type GenerateFailure =
  | 'disabled' // zero-knowledge custody is off — no report path exists
  | 'no_key' // this device holds no envelope private key
  | 'no_event' // the event is not the caller's, or is gone
  | 'no_commitments' // nothing was committed at capture time; nothing to certify
  | 'not_certified' // the server declined to sign
  | 'network';

export type GenerateResult =
  | { ok: true; evidence: EvidenceZone; signed: SignedAttestation }
  | { ok: false; reason: GenerateFailure };

/** Per-report opt-ins. Every one defaults OFF: auto-population is offered AFTER she taps
 *  "start a report", never pre-filled before (§1 [A]). */
export interface PopulateOptions {
  includeLocation: boolean;
  includeNotifications: boolean;
  includeCapture: boolean;
}

interface MetadataResponse {
  metadata: {
    event: EventMetadata;
    locations: LocationPoint[];
    deliveries: DeliveryRecord[];
    chunks: ChunkIndexEntry[];
  };
}

interface EnvelopeResponse {
  envelope: { wrappedDek: string; algId: string; commitments: Commitment[] } | null;
}

/** The owner's own events, newest first. */
export async function listReportableEvents(): Promise<ReportEventSummary[] | null> {
  const res = await api<{ events: ReportEventSummary[] }>('/v1/me/reports/events');
  return res.ok && res.data ? res.data.events : null;
}

/** Fetch one still-encrypted chunk. Raw fetch, not the JSON api helper — these are bytes. */
async function fetchChunkBytes(eventId: string, sequence: number): Promise<Uint8Array | null> {
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

/**
 * Build and certify the evidence zone for one event.
 *
 * Note what is NOT sent anywhere: the evidence zone itself. `computeEvidenceHashes` runs
 * locally and only two SHA-256 values go to the signing endpoint.
 */
export async function generateCertifiedEvidence(
  eventId: string,
  options: PopulateOptions,
  now: number,
): Promise<GenerateResult> {
  if (!envelopeEncryptionEnabled) {
    return { ok: false, reason: 'disabled' };
  }

  const metaRes = await api<MetadataResponse>(`/v1/me/reports/events/${eventId}/metadata`);
  if (metaRes.status === 0) return { ok: false, reason: 'network' };
  if (!metaRes.ok || !metaRes.data) return { ok: false, reason: 'no_event' };
  const { event, locations, deliveries, chunks } = metaRes.data.metadata;

  const envRes = await api<EnvelopeResponse>(`/v1/me/events/${eventId}/envelope`);
  if (envRes.status === 0) return { ok: false, reason: 'network' };
  const envelope = envRes.data?.envelope ?? null;
  if (!envelope || envelope.commitments.length === 0) {
    // Either a plaintext capture or one with no capture-time commitments. Nothing to
    // certify against, and we do not pretend otherwise.
    return { ok: false, reason: 'no_commitments' };
  }

  let capture = emptyCaptureEvidence();
  if (options.includeCapture) {
    const keypair = await getStoredEnvelopeKeypair();
    if (!keypair?.privateKey) {
      return { ok: false, reason: 'no_key' };
    }
    capture = await buildCaptureEvidence({
      eventId,
      wrappedDekJson: envelope.wrappedDek,
      privateKeyB64: keypair.privateKey,
      commitments: envelope.commitments,
      index: chunks,
      fetchChunk: (sequence) => fetchChunkBytes(eventId, sequence),
    });
  }

  const evidence = await buildEvidenceZone({
    generatedAt: now,
    event,
    includeLocation: options.includeLocation,
    includeNotifications: options.includeNotifications,
    locations,
    deliveries,
    capture,
    commitments: envelope.commitments,
    algorithm: envelope.algId || ENVELOPE_ALG,
  });

  // ONLY the hashes leave the device.
  const hashes = await computeEvidenceHashes(evidence);
  const signRes = await api<SignedAttestation>('/v1/me/reports/sign', {
    method: 'POST',
    body: { eventId, evidenceHash: hashes.evidenceHash, renderedHash: hashes.renderedHash },
  });
  if (signRes.status === 0) return { ok: false, reason: 'network' };
  if (!signRes.ok || !signRes.data?.signature) {
    const reason: GenerateFailure =
      (signRes.data as { error?: string } | null)?.error === 'no_commitments' ? 'no_commitments' : 'not_certified';
    return { ok: false, reason };
  }

  return { ok: true, evidence, signed: signRes.data };
}

/** Assemble the downloadable file. Her statement is placed outside every signed byte, so
 *  she can revise it later and the certification still verifies (§2). */
export function buildReportFile(evidence: EvidenceZone, signed: SignedAttestation, statement: string): string {
  const payload: CertifiedReportPayload = {
    evidence,
    attestation: signed.attestation,
    signature: signed.signature,
    publicKey: signed.publicKey,
  };
  return renderReportHtml({ ...payload, statement });
}
