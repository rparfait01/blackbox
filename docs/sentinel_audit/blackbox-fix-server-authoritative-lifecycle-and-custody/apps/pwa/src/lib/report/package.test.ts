import { describe, expect, it } from 'vitest';

import { buildEvidencePackage, manifestHash, PACKAGE_FORMAT, type PackageInput } from './package';
import { zipStore } from './zip';

/**
 * Item D1 — the evidence package.
 *
 * The assertions that matter here are the FLOOR ones: that a package still assembles, still
 * carries every raw byte, and still verifies when every optional enhancement is absent.
 * Report generation cannot fail to produce accessible evidence.
 */

const blob = (s: string): Blob => new Blob([s], { type: 'video/webm' });

function input(overrides: Partial<PackageInput> = {}): PackageInput {
  return {
    eventId: 'evt-1',
    generatedAt: 1_700_000_000_000,
    chunks: [
      { sequence: 0, data: blob('HEADER+cluster0'), mimeType: 'video/webm; codecs=vp09.00.10.08,opus' },
      { sequence: 1, data: blob('cluster1'), mimeType: 'video/webm; codecs=vp09.00.10.08,opus' },
      { sequence: 2, data: blob('cluster2'), mimeType: 'video/webm; codecs=vp09.00.10.08,opus' },
    ],
    remuxed: null,
    locationJson: '{"points":[]}',
    locationGpx: '<gpx></gpx>',
    originJson: '{"triggerType":"manual","dtgStart":1}',
    situationJson: '{"threatLevel":null}',
    reportHtml: '<html></html>',
    ...overrides,
  };
}

/** Minimal store-only ZIP reader, so the tests read the archive the way a verifier will
 *  rather than trusting the writer's own bookkeeping. */
async function readZip(zip: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const out = new Map<string, Uint8Array>();
  // Walk local file headers from the front; store-only, no data descriptors.
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const dataAt = at + 30 + nameLen + extraLen;
    out.set(name, bytes.subarray(dataAt, dataAt + size));
    at = dataAt + size;
  }
  return out;
}

describe('D1 the ZIP is a well-formed, store-only archive', () => {
  it('round-trips every entry byte-for-byte', async () => {
    const zip = await zipStore([
      { name: 'a.txt', data: new Blob(['hello']) },
      { name: 'nested/b.bin', data: new Blob([new Uint8Array([0, 1, 2, 255])]) },
    ]);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['a.txt', 'nested/b.bin']);
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect([...files.get('nested/b.bin')!]).toEqual([0, 1, 2, 255]);
  });

  it('is deterministic — same inputs, same bytes', async () => {
    const make = (): Promise<Blob> => zipStore([{ name: 'x', data: new Blob(['same']) }]);
    const a = new Uint8Array(await (await make()).arrayBuffer());
    const b = new Uint8Array(await (await make()).arrayBuffer());
    expect([...a]).toEqual([...b]);
  });

  it('ends with a central directory a reader can find', async () => {
    const zip = await zipStore([{ name: 'x', data: new Blob(['y']) }]);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  });
});

describe('D1 [A] the FLOOR: a package with no remux is still complete', () => {
  it('assembles with every required part present', async () => {
    const result = await buildEvidencePackage(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = await readZip(result.zip);
    for (const required of [
      'chunks/000000.webm',
      'chunks/000001.webm',
      'chunks/000002.webm',
      'capture.webm',
      'location.json',
      'location.gpx',
      'origin.json',
      'situation.json',
      'report.html',
      'VERIFY.txt',
      'manifest.json',
    ]) {
      expect(files.has(required), `${required} must be in the package`).toBe(true);
    }
  });

  it('carries the raw segments byte-for-byte — ground truth is untouched', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    expect(new TextDecoder().decode(files.get('chunks/000000.webm'))).toBe('HEADER+cluster0');
    expect(new TextDecoder().decode(files.get('chunks/000002.webm'))).toBe('cluster2');
  });

  it('the playable file is the in-order concatenation, reproducible with cat', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    expect(new TextDecoder().decode(files.get('capture.webm'))).toBe('HEADER+cluster0cluster1cluster2');
  });

  it('segments are ordered by sequence, not by arrival', async () => {
    const shuffled = input();
    shuffled.chunks = [shuffled.chunks[2], shuffled.chunks[0], shuffled.chunks[1]];
    const result = await buildEvidencePackage(shuffled);
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    // Order is meaning: a mis-ordered concatenation is an unplayable file.
    expect(new TextDecoder().decode(files.get('capture.webm'))).toBe('HEADER+cluster0cluster1cluster2');
    expect(result.manifest.chunks.map((c) => c.path)).toEqual([
      'chunks/000000.webm',
      'chunks/000001.webm',
      'chunks/000002.webm',
    ]);
  });

  it('states PLAINLY that it is not remuxed, and why — no silent degradation', async () => {
    const result = await buildEvidencePackage(input({ remuxFailureReason: 'not_supported_container' }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.playback.remuxed).toBe(false);
    expect(result.manifest.playback).toMatchObject({ reason: 'not_supported_container', derivedFromChunks: true });
    const files = await readZip(result.zip);
    const note = new TextDecoder().decode(files.get('VERIFY.txt'));
    expect(note).toMatch(/no duration or seek index|may show 0:00/);
    expect(note).toMatch(/No evidence is missing/);
    expect(note).toMatch(/cat chunks\/\* > capture\.webm/);
  });

  it('an MP4 capture ships the floor and says so — never a silent absence', async () => {
    const mp4 = input();
    mp4.chunks = mp4.chunks.map((c) => ({ ...c, mimeType: 'video/mp4;codecs=h264,mp4a.40.2' }));
    const result = await buildEvidencePackage({ ...mp4, remuxFailureReason: 'not_supported_container' });
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    expect(files.has('chunks/000000.mp4')).toBe(true);
    expect(files.has('capture.mp4')).toBe(true);
    const note = new TextDecoder().decode(files.get('VERIFY.txt'));
    expect(note).toMatch(/WebM only/);
    expect(note).toMatch(/MP4 support is a known, named future addition/);
  });
});

describe('D1 [A] the manifest is the thing a verifier checks', () => {
  it('hashes EVERY file in the archive, including its own instructions', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    const listed = [...result.manifest.chunks, ...result.manifest.files].map((f) => f.path);
    // Everything in the ZIP is accounted for except the manifest itself.
    const inZip = [...files.keys()].filter((n) => n !== 'manifest.json');
    expect(new Set(listed)).toEqual(new Set(inZip));
    expect(listed).toContain('VERIFY.txt');
  });

  it('every recorded hash actually matches the stored bytes', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    for (const f of [...result.manifest.chunks, ...result.manifest.files]) {
      const bytes = files.get(f.path)!;
      const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(hex, `${f.path} hash must match`).toBe(f.sha256);
      expect(f.bytes).toBe(bytes.length);
    }
  });

  it('the signed hash is a SHA-256 of the manifest — non-invertible, so ZK holds', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const hash = await manifestHash(result.manifest);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Altering ANY file hash changes what gets signed.
    const tampered = structuredClone(result.manifest);
    tampered.chunks[0].sha256 = 'f'.repeat(64);
    expect(await manifestHash(tampered)).not.toBe(hash);
  });

  it('the signed hash EXCLUDES the attestation, or the chain would be circular', async () => {
    // The attestation is the signature over this hash. If the hash covered it, neither side
    // could ever compute it. A verifier strips it before recomputing, so attaching it must
    // not move the hash.
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    const before = await manifestHash(result.manifest);
    const withAttestation = { ...result.manifest, attestation: { signature: 'abc', chainSeq: 7 } };
    expect(await manifestHash(withAttestation)).toBe(before);
    // But any real content change still moves it.
    const moved = structuredClone(result.manifest);
    moved.files[0].bytes += 1;
    expect(await manifestHash(moved)).not.toBe(before);
  });

  it('declares its format and event so a reader knows what they have', async () => {
    const result = await buildEvidencePackage(input());
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.format).toBe(PACKAGE_FORMAT);
    expect(result.manifest.eventId).toBe('evt-1');
    expect(result.filename).toBe('blackbox-evidence-evt-1.zip');
  });
});

describe('D1 [A] failure is honest, never silent', () => {
  it('refuses when there is nothing to package', async () => {
    const result = await buildEvidencePackage(input({ chunks: [] }));
    expect(result).toEqual({ ok: false, reason: 'no_chunks' });
  });

  it('a remuxed file, when present, replaces only the convenience file', async () => {
    const result = await buildEvidencePackage(
      input({ remuxed: { data: new Blob(['SEEKABLE']), container: 'video/webm' } }),
    );
    if (!result.ok) throw new Error('expected ok');
    const files = await readZip(result.zip);
    expect(new TextDecoder().decode(files.get('capture.webm'))).toBe('SEEKABLE');
    // Ground truth is still every original segment, untouched.
    expect(new TextDecoder().decode(files.get('chunks/000001.webm'))).toBe('cluster1');
    expect(result.manifest.playback.remuxed).toBe(true);
  });
});
