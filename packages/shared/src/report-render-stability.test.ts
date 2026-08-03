import { describe, expect, it } from 'vitest';

import { renderEvidenceText } from './report-document';
import { sha256Hex } from './hmac';
import type { EvidenceZone } from './report';

/**
 * Brief 43 §C — THE RENDERER'S OUTPUT IS A SIGNED ARTIFACT, SO ITS BYTES ARE PINNED.
 *
 * `renderEvidenceText` was made total against hostile input: a document carrying `"evidence":{}`
 * used to throw a TypeError out of the verifier instead of producing a verdict. The hardening is
 * all coercion — `asRecord`, `asArray` — and coercion is exactly the kind of change that can
 * silently alter output for VALID input too.
 *
 * That would not be a cosmetic regression. `renderedHash` of this text is bound into every
 * attestation BLACK BOX has ever signed, and the verifier re-renders from the signed JSON and
 * compares. One byte of drift here and every previously certified report — including any already
 * filed with a court — verifies as TAMPERED. The document is fine; the renderer moved.
 *
 * So the guard is a hash of the rendered text against a constant COMPUTED FROM THE PRE-CHANGE
 * CODE (`git stash` the file, render, record, restore). A self-consistent pin — rendering twice in
 * one process and comparing — would pass no matter how far the output drifted, which is the
 * vacuous class this brief's own §D sweep was written to catch.
 *
 * The fixture deliberately drives EVERY branch: location included with points, notifications
 * included with records, capture included with a missing final-chunk marker, and chunks in all
 * three commitment states (verified / failed / none recorded). A pin over a fixture that only
 * exercises the empty branches would hold while the populated ones drifted.
 */
const FIXTURE: EvidenceZone = {
  formatVersion: 1,
  generatedAt: '2026-07-30T05:32:00.000Z',
  event: {
    eventId: 'evt_render_stability',
    openedAt: '2026-07-30T05:10:00.000Z',
    closedAt: '2026-07-30T05:31:00.000Z',
    durationMs: 1260000,
    status: 'closed',
    closedBy: 'owner',
    tzOffsetMinutes: -540,
    coordinatorEngagedAt: '2026-07-30T05:12:00.000Z',
    securedAt: null,
    escalatedAt: '2026-07-30T05:20:00.000Z',
    escalationTier: 'tier2',
  },
  location: {
    included: true,
    pointCount: 2,
    points: [
      { at: '2026-07-30T05:11:00.000Z', lat: 26.3344, lon: 127.8056, accuracyM: 12 },
      { at: '2026-07-30T05:19:00.000Z', lat: 26.3351, lon: 127.8061, accuracyM: null },
    ],
  },
  notifications: {
    included: true,
    count: 2,
    records: [
      { at: '2026-07-30T05:10:05.000Z', kind: 'alert', channel: 'sms', status: 'delivered' },
      { at: '2026-07-30T05:10:06.000Z', kind: 'alert', channel: 'email', status: 'failed' },
    ],
  },
  capture: {
    included: true,
    chunkCount: 3,
    totalBytes: 903168,
    firstChunkAt: '2026-07-30T05:10:02.000Z',
    lastChunkAt: '2026-07-30T05:30:44.000Z',
    // false on purpose — it prints the truncation NOTE, another branch that must not drift.
    finalChunkPresent: false,
    chunksVerified: 1,
    chunksFailed: 1,
    chunks: [
      {
        sequence: 0,
        recordedAt: '2026-07-30T05:10:02.000Z',
        bytes: 301056,
        mimeType: 'video/webm',
        isFinal: false,
        wasEncrypted: true,
        commitment: 'a'.repeat(64),
        commitmentVerified: true,
      },
      {
        sequence: 1,
        recordedAt: '2026-07-30T05:20:23.000Z',
        bytes: 301056,
        mimeType: 'video/webm',
        isFinal: false,
        wasEncrypted: true,
        commitment: 'b'.repeat(64),
        commitmentVerified: false,
      },
      {
        sequence: 2,
        recordedAt: '2026-07-30T05:30:44.000Z',
        bytes: 301056,
        mimeType: 'video/webm',
        isFinal: false,
        // plaintext fallback — the fail-open capture path, reported not hidden
        wasEncrypted: false,
        commitment: null,
        commitmentVerified: null,
      },
    ],
  },
  custody: {
    commitmentCount: 3,
    commitmentsHash: 'c'.repeat(64),
    algorithm: 'AES-GCM-256',
  },
};

/**
 * Computed by rendering FIXTURE with the code as it stood at HEAD before the §C hardening.
 * If this constant has to change, the renderer's output changed, and every report signed before
 * that change now verifies as TAMPERED. That is a migration, never a test edit.
 */
const PINNED_RENDER_SHA256 = 'ac082207434bbe3b994fe07e20d403ddd1fa74f4339662cadee20bad9b4e2fa9';

describe('the evidence renderer is byte-stable across the §C hardening', () => {
  it('renders the pinned fixture to exactly the bytes it rendered before', async () => {
    const text = renderEvidenceText(FIXTURE);
    expect(await sha256Hex(new TextEncoder().encode(text))).toBe(PINNED_RENDER_SHA256);
  });

  it('drives every branch, so the pin covers the populated paths and not just the empty ones', () => {
    const text = renderEvidenceText(FIXTURE);
    // A pin over a fixture missing these would hold while the branches under it drifted.
    expect(text).toContain('lat 26.3344');
    expect(text).toContain('accuracy unknown'); // accuracyM: null
    expect(text).toContain('via sms');
    expect(text).toContain('may be incomplete'); // finalChunkPresent: false
    expect(text).toContain('yes');
    expect(text).toContain('NO');
    expect(text).toContain('none recorded'); // commitment: null
  });

  it('still renders — rather than throwing — when the evidence is not shaped like evidence', () => {
    // The §C property itself, at the renderer rather than through the verifier. Each of these
    // reached a bare dereference before: `.event.eventId`, `.location.included`, `.capture.chunks`.
    for (const hostile of [
      {},
      null,
      undefined,
      { event: null, location: null, notifications: null, capture: null, custody: null },
      { location: { included: true, pointCount: 3, points: 'not-an-array' } },
      { notifications: { included: true, count: 1, records: [null] } },
      { capture: { included: true, chunks: [null, 7, 'x'] } },
    ]) {
      expect(
        () => renderEvidenceText(hostile as unknown as EvidenceZone),
        `renderEvidenceText threw on ${JSON.stringify(hostile)}`,
      ).not.toThrow();
    }
  });
});
