/**
 * Test fixtures for the certified report (Brief 29).
 *
 * The signing key here is generated per test run — the real one is a Worker secret and
 * never appears in the repo. What these fixtures exercise is the SHAPE of the ceremony:
 * a device-computed hash, signed server-side over the canonical attestation, verified
 * against the published public key.
 */
import { canonicalize } from './canonical';
import { computeEvidenceHashes } from './document';
import { REPORT_SIGNATURE_ALG } from '@blackbox/shared';
import type { CertifiedReportPayload, EvidenceZone, ReportAttestation } from '@blackbox/shared';

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A fully-populated evidence zone with a mixed capture — an encrypted chunk that matches
 *  its commitment, and a plaintext fail-open chunk — because a real record has both. */
export function sampleEvidence(): EvidenceZone {
  return {
    formatVersion: 1,
    generatedAt: '2026-07-25T10:00:00.000Z',
    event: {
      eventId: 'evt-1',
      openedAt: '2026-07-25T09:00:00.000Z',
      closedAt: '2026-07-25T09:30:00.000Z',
      durationMs: 1_800_000,
      status: 'closed',
      closedBy: 'user',
      tzOffsetMinutes: 540,
      coordinatorEngagedAt: '2026-07-25T09:05:00.000Z',
      securedAt: null,
      escalatedAt: null,
      escalationTier: null,
    },
    location: {
      included: true,
      pointCount: 1,
      points: [{ at: '2026-07-25T09:01:00.000Z', lat: 35.6812, lon: 139.7671, accuracyM: 12 }],
    },
    notifications: {
      included: true,
      count: 1,
      records: [{ at: '2026-07-25T09:00:05.000Z', kind: 'activation', channel: 'line', status: 'delivered' }],
    },
    capture: {
      included: true,
      chunkCount: 2,
      totalBytes: 2048,
      firstChunkAt: '2026-07-25T09:00:01.000Z',
      lastChunkAt: '2026-07-25T09:00:02.000Z',
      finalChunkPresent: true,
      chunksVerified: 2,
      chunksFailed: 0,
      chunks: [
        {
          sequence: 0,
          recordedAt: '2026-07-25T09:00:01.000Z',
          bytes: 1024,
          mimeType: 'audio/webm',
          isFinal: false,
          wasEncrypted: true,
          commitment: 'a'.repeat(64),
          commitmentVerified: true,
        },
        {
          sequence: 1,
          recordedAt: '2026-07-25T09:00:02.000Z',
          bytes: 1024,
          mimeType: 'audio/webm',
          isFinal: true,
          wasEncrypted: false,
          commitment: 'b'.repeat(64),
          commitmentVerified: true,
        },
      ],
    },
    custody: {
      commitmentCount: 2,
      commitmentsHash: 'c'.repeat(64),
      algorithm: 'p256-hkdf-sha256-aes256gcm/v1',
    },
  };
}

export interface SigningFixture {
  publicKey: string;
  sign: (data: string) => Promise<string>;
}

/** A throwaway ECDSA P-256 keypair standing in for the Worker's REPORT_SIGNING_KEY. */
export async function signingFixture(): Promise<SigningFixture> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = bytesToB64(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));
  return {
    publicKey,
    sign: async (data: string) =>
      bytesToB64(
        new Uint8Array(
          await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(data)),
        ),
      ),
  };
}

/** A genuinely signed report — the device hashes, the "server" signs the attestation. */
export async function sampleReport(evidence: EvidenceZone = sampleEvidence()): Promise<CertifiedReportPayload> {
  const fixture = await signingFixture();
  const hashes = await computeEvidenceHashes(evidence);
  const attestation: ReportAttestation = {
    format: 'blackbox-certified-report/v1',
    alg: REPORT_SIGNATURE_ALG,
    eventId: evidence.event.eventId,
    evidenceHash: hashes.evidenceHash,
    renderedHash: hashes.renderedHash,
    commitmentsHash: evidence.custody.commitmentsHash,
    chainHead: 'd'.repeat(64),
    chainSeq: 41,
    signedAt: '2026-07-25T10:00:01.000Z',
  };
  return {
    evidence,
    attestation,
    signature: await fixture.sign(canonicalize(attestation)),
    publicKey: fixture.publicKey,
  };
}
