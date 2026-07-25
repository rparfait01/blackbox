/**
 * The certified report (Brief 29) — the shape of the signed artifact.
 *
 * These declarations are SHARED because the document format is a contract between three
 * parties that must not drift: the device that builds and hashes a report, the Worker that
 * signs it, and the verifier that checks it. One declaration, all three sides.
 *
 * NOTE WHAT IS ABSENT FROM THE ATTESTATION: any plaintext. The server receives two hashes
 * and an event id, binds its OWN copy of the custody facts (the commitments it recorded at
 * capture time and its integrity-chain head), and signs that. It cannot reconstruct the
 * report from what it signed — this is the "sign the hash, not the content" property that
 * keeps §2 compatible with zero-knowledge custody.
 */

/** Format identifier carried by both the attestation and the document. */
export const REPORT_DOCUMENT_FORMAT = 'blackbox-certified-report/v1';

export const EVIDENCE_FORMAT_VERSION = 1;

export interface ReportAttestation {
  format: string;
  alg: 'Ed25519';
  eventId: string;
  /** SHA-256 of the canonical evidence-zone JSON — computed on the survivor's device. */
  evidenceHash: string;
  /** SHA-256 of the normalized visible evidence text — computed on her device. */
  renderedHash: string;
  /** Canonical hash of the capture-time commitments, recomputed SERVER-side from its own
   *  rows — so the commitments printed in a document cannot be swapped for another set. */
  commitmentsHash: string;
  /** The event's integrity-chain head at signing (Fix Brief 2 #C2), tying the report to
   *  the append-only chain the server has kept since capture. Null when none exists. */
  chainHead: string | null;
  chainSeq: number | null;
  /** UTC ISO-8601, server clock. */
  signedAt: string;
}

/** What the sign endpoint returns and the document embeds. */
export interface SignedAttestation {
  attestation: ReportAttestation;
  /** Ed25519 signature (base64) over canonicalize(attestation). */
  signature: string;
  /** The published SPKI public key (base64) it was signed with. */
  publicKey: string;
}

// ---- the evidence zone (the SIGNED half) ----

export interface LocationEvidence {
  at: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface NotificationEvidence {
  at: string;
  kind: string;
  channel: string;
  status: string;
}

export interface ChunkEvidence {
  sequence: number;
  recordedAt: string;
  bytes: number;
  mimeType: string;
  isFinal: boolean;
  /** false when this chunk was stored plaintext — the capture path's fail-open fallback
   *  (Brief 26). Reported, never hidden: a mixed capture is a fact about the record. */
  wasEncrypted: boolean;
  /** The server-held pre-encryption commitment, or null if none was recorded. */
  commitment: string | null;
  /** true  — decrypted bytes hash to the commitment: this chunk is what the device captured.
   *  false — they do not: a real integrity signal a court must see.
   *  null  — no commitment on record to check against. */
  commitmentVerified: boolean | null;
}

export interface CaptureEvidence {
  included: boolean;
  chunkCount: number;
  totalBytes: number;
  firstChunkAt: string | null;
  lastChunkAt: string | null;
  /** true when the final-chunk marker is present — its absence means a silently truncated
   *  tail is possible, and the report says so rather than implying completeness. */
  finalChunkPresent: boolean;
  chunksVerified: number;
  chunksFailed: number;
  chunks: ChunkEvidence[];
}

export interface EvidenceZone {
  formatVersion: number;
  generatedAt: string;
  event: {
    eventId: string;
    openedAt: string;
    closedAt: string | null;
    durationMs: number | null;
    status: string;
    closedBy: string | null;
    tzOffsetMinutes: number | null;
    coordinatorEngagedAt: string | null;
    securedAt: string | null;
    escalatedAt: string | null;
    escalationTier: string | null;
  };
  location: { included: boolean; pointCount: number; points: LocationEvidence[] };
  notifications: { included: boolean; count: number; records: NotificationEvidence[] };
  capture: CaptureEvidence;
  custody: {
    commitmentCount: number;
    /** Canonical hash of the ordered commitment list. The server independently recomputes
     *  this from its own rows and binds it into the attestation, so the commitments printed
     *  in the document cannot be swapped for a different set. */
    commitmentsHash: string;
    algorithm: string;
  };
}

/** The machine-readable payload embedded in every certified report document. */
export interface CertifiedReportPayload {
  evidence: EvidenceZone;
  attestation: ReportAttestation;
  signature: string;
  publicKey: string;
}
