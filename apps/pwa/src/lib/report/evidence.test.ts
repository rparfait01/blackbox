import { describe, expect, it } from 'vitest';

import {
  encryptChunk,
  exportPrivateKey,
  generateDek,
  generateEnvelopeKeypair,
  plaintextCommitment,
  randomIvPrefix,
  wrapDek,
} from '@/lib/crypto/envelope';
import { buildCaptureEvidence, buildEvidenceZone, commitmentsHash, emptyCaptureEvidence } from './evidence';
import { canonicalHash } from './canonical';

/**
 * Brief 29 §1.3 — the evidence summary is built by decrypting HER capture with HER key, on
 * her device, and every chunk is checked against the commitment recorded at capture time.
 *
 * These tests drive the REAL envelope primitives (Brief 26), not stubs: a chunk is
 * encrypted exactly as the capture path encrypts it, then opened exactly as the report
 * path opens it. That round trip is the whole zero-knowledge claim, so it is tested end to
 * end rather than mocked.
 */

const EVENT_ID = 'evt-1';
const T0 = Date.UTC(2026, 6, 25, 9, 0, 0);

async function fixture(opts: { tamperChunk1?: boolean; plaintextChunk1?: boolean } = {}) {
  const kp = await generateEnvelopeKeypair();
  const privateKeyB64 = await exportPrivateKey(kp.privateKey);
  const dek = await generateDek();
  const ivPrefix = randomIvPrefix();
  const wrappedDekJson = JSON.stringify(await wrapDek(dek, kp.publicKey));

  const p0 = new TextEncoder().encode('chunk zero payload');
  const p1 = new TextEncoder().encode('chunk one payload');
  const commitments = [
    { sequence: 0, plaintextHash: await plaintextCommitment(p0) },
    { sequence: 1, plaintextHash: await plaintextCommitment(p1) },
  ];

  const c0 = await encryptChunk({ dek, plaintext: p0, captureId: EVENT_ID, chunkIndex: 0, isFinal: false, ivPrefix });
  let c1: Uint8Array;
  if (opts.plaintextChunk1) {
    c1 = p1; // the capture path's fail-open fallback: a plaintext chunk in an encrypted capture
  } else {
    c1 = await encryptChunk({ dek, plaintext: p1, captureId: EVENT_ID, chunkIndex: 1, isFinal: true, ivPrefix });
    if (opts.tamperChunk1) c1[c1.length - 1] ^= 0xff; // flip a bit in the GCM tag
  }

  const bytes = new Map<number, Uint8Array>([
    [0, c0],
    [1, c1],
  ]);
  return {
    privateKeyB64,
    wrappedDekJson,
    commitments,
    index: [
      { sequence: 0, sizeBytes: c0.length, mimeType: 'audio/webm', createdAt: T0 + 1000, isFinal: 0 },
      { sequence: 1, sizeBytes: c1.length, mimeType: 'audio/webm', createdAt: T0 + 2000, isFinal: 1 },
    ],
    fetchChunk: async (seq: number) => bytes.get(seq) ?? null,
  };
}

describe('the capture summary comes from real on-device decryption', () => {
  it('decrypts every chunk and confirms it against its capture-time commitment', async () => {
    const f = await fixture();
    const capture = await buildCaptureEvidence({ eventId: EVENT_ID, ...f });

    expect(capture.chunkCount).toBe(2);
    expect(capture.chunksVerified).toBe(2);
    expect(capture.chunksFailed).toBe(0);
    expect(capture.finalChunkPresent).toBe(true);
    expect(capture.chunks.every((c) => c.commitmentVerified === true)).toBe(true);
    expect(capture.chunks.every((c) => c.wasEncrypted)).toBe(true);
  });

  it('reports a tampered chunk as FAILED rather than dropping it', async () => {
    const f = await fixture({ tamperChunk1: true });
    const capture = await buildCaptureEvidence({ eventId: EVENT_ID, ...f });

    // The bad chunk is still in the record — a court must see the disagreement.
    expect(capture.chunkCount).toBe(2);
    expect(capture.chunksFailed).toBe(1);
    expect(capture.chunks[1].commitmentVerified).toBe(false);
  });

  it('reports a plaintext fail-open chunk honestly, and still checks its commitment', async () => {
    const f = await fixture({ plaintextChunk1: true });
    const capture = await buildCaptureEvidence({ eventId: EVENT_ID, ...f });

    expect(capture.chunks[0].wasEncrypted).toBe(true);
    expect(capture.chunks[1].wasEncrypted).toBe(false);
    // A plaintext chunk still hashes to its commitment — the content is unchanged.
    expect(capture.chunks[1].commitmentVerified).toBe(true);
  });

  it('fails every chunk under the WRONG key — decryption is genuinely key-bound', async () => {
    const f = await fixture();
    const other = await generateEnvelopeKeypair();
    const otherDek = await generateDek();
    const wrongWrap = JSON.stringify(await wrapDek(otherDek, other.publicKey));

    const capture = await buildCaptureEvidence({
      eventId: EVENT_ID,
      ...f,
      wrappedDekJson: wrongWrap,
      privateKeyB64: await exportPrivateKey(other.privateKey),
    });
    expect(capture.chunksVerified).toBe(0);
    expect(capture.chunksFailed).toBe(2);
  });

  it('omits a chunk whose bytes are missing, without failing the report', async () => {
    const f = await fixture();
    const capture = await buildCaptureEvidence({
      eventId: EVENT_ID,
      ...f,
      fetchChunk: async (seq: number) => (seq === 0 ? f.fetchChunk(0) : null),
    });
    expect(capture.chunkCount).toBe(1);
    expect(capture.chunksVerified).toBe(1);
  });
});

describe('the evidence zone is deterministic and opt-in', () => {
  const event = {
    eventId: EVENT_ID,
    createdAt: T0,
    closedAt: T0 + 1_800_000,
    status: 'closed',
    closedBy: 'user',
    tzOffsetMinutes: 540,
    coordinatorClaimedAt: null,
    escalatedAt: null,
    escalationTier: null,
    securedAt: null,
  };
  const locations = [{ timestamp: T0 + 500, lat: 35.1, lon: 139.2, accuracyM: 10 }];
  const deliveries = [{ createdAt: T0 + 100, messageKind: 'activation', channel: 'line', status: 'delivered' }];
  const commitments = [{ sequence: 0, plaintextHash: 'a'.repeat(64) }];

  const base = {
    generatedAt: T0 + 3_600_000,
    event,
    locations,
    deliveries,
    capture: emptyCaptureEvidence(),
    commitments,
    algorithm: 'p256-hkdf-sha256-aes256gcm/v1',
  };

  it('produces byte-identical output for identical input', async () => {
    const a = await buildEvidenceZone({ ...base, includeLocation: true, includeNotifications: true });
    const b = await buildEvidenceZone({ ...base, includeLocation: true, includeNotifications: true });
    expect(await canonicalHash(a)).toBe(await canonicalHash(b));
  });

  it('includes NOTHING that was not opted into', async () => {
    const zone = await buildEvidenceZone({ ...base, includeLocation: false, includeNotifications: false });
    expect(zone.location.included).toBe(false);
    expect(zone.location.points).toEqual([]);
    expect(zone.location.pointCount).toBe(0);
    expect(zone.notifications.included).toBe(false);
    expect(zone.notifications.records).toEqual([]);
    expect(zone.capture.included).toBe(false);
  });

  it('derives the duration arithmetically, never by assertion', async () => {
    const zone = await buildEvidenceZone({ ...base, includeLocation: false, includeNotifications: false });
    expect(zone.event.durationMs).toBe(1_800_000);
    expect(zone.event.openedAt).toBe(new Date(T0).toISOString());
  });

  it('binds the commitments by hash, order-fixed', async () => {
    const forward = await commitmentsHash([
      { sequence: 0, plaintextHash: 'a'.repeat(64) },
      { sequence: 1, plaintextHash: 'b'.repeat(64) },
    ]);
    // Same set, arriving in a different row order — sorting by sequence makes it stable.
    const reversed = await commitmentsHash([
      { sequence: 1, plaintextHash: 'b'.repeat(64) },
      { sequence: 0, plaintextHash: 'a'.repeat(64) },
    ]);
    expect(forward).toBe(reversed);
    // A genuinely different set hashes differently.
    const different = await commitmentsHash([{ sequence: 0, plaintextHash: 'c'.repeat(64) }]);
    expect(different).not.toBe(forward);
  });
});
