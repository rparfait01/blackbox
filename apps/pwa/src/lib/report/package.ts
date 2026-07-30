/**
 * The evidence package (Item D1) — one verifiable ZIP the survivor releases.
 *
 * THE FLOOR IS THE POINT. Report generation cannot fail to produce accessible evidence. Every
 * enhancement in here is optional and every one of them is allowed to be absent; the raw
 * signed chunks, the manifest, and the instructions to reassemble them are not. If the
 * seamless file cannot be built, the package still ships and still verifies — it simply says
 * so, in writing, where a reader cannot miss it.
 *
 * GROUND TRUTH IS THE RAW CHUNKS. The manifest hashes the segments exactly as they were
 * captured, uploaded, and committed to at capture time. `capture.*` is a convenience: a plain
 * in-order byte concatenation of those same segments, which is how MediaRecorder output is
 * meant to be reassembled (segment 0 carries the container header; the rest are continuations,
 * verified from the stored bytes). It is derived, never authoritative. If anyone disputes it,
 * the raw chunks settle it and the derivation is reproducible with `cat`.
 *
 * ON-DEVICE, ZERO-KNOWLEDGE. Everything here is assembled on her phone from her own decrypted
 * material. The only thing that leaves is a hash the server cannot invert (see signManifest).
 */
import { canonicalHash, canonicalize } from './canonical';
import { zipStore, ZipTooLargeError, type ZipEntry } from './zip';

export const PACKAGE_FORMAT = 'blackbox.evidence-package.v1';

/** Why the seamless file is or is not present — stated, never implied. */
export type RemuxStatus =
  | { remuxed: true; container: string }
  | { remuxed: false; reason: 'not_supported_container' | 'failed' | 'not_attempted'; container: string };

export interface PackageFileHash {
  path: string;
  sha256: string;
  bytes: number;
}

export interface EvidenceManifest {
  format: typeof PACKAGE_FORMAT;
  eventId: string;
  generatedAt: string;
  /** Ground truth: the capture segments, in order, hashed as stored. */
  chunks: PackageFileHash[];
  /** Every other file in the archive, hashed. */
  files: PackageFileHash[];
  /** The write-once t=0 record, carried inline so it is signed with everything else. */
  origin: unknown;
  /** Whether `capture.*` was remuxed for seeking, or is a plain concatenation, and WHY. */
  playback: RemuxStatus & {
    /** Always true for the concatenation: it is reproducible from the signed chunks. */
    derivedFromChunks: boolean;
    note: string;
  };
  /** The Brief 29 attestation over the evidence zone, unchanged and still independently
   *  checkable on its own. The package does not replace it; it carries it. */
  attestation?: unknown;
}

export interface PackageInput {
  eventId: string;
  generatedAt: number;
  /** Raw stored segments in ascending sequence. Ground truth. */
  chunks: Array<{ sequence: number; data: Blob; mimeType: string }>;
  /** The seamless, seekable file when D2 could build one; null means the floor applies. */
  remuxed: { data: Blob; container: string } | null;
  remuxFailureReason?: 'not_supported_container' | 'failed' | 'not_attempted';
  locationJson: string;
  locationGpx: string;
  originJson: string;
  situationJson: string;
  reportHtml: string;
  attestation?: unknown;
}

export type PackageFailure = 'too_large' | 'no_chunks' | 'zip_failed';
export type PackageResult =
  | { ok: true; zip: Blob; manifest: EvidenceManifest; filename: string }
  | { ok: false; reason: PackageFailure };

const enc = new TextEncoder();
const textBlob = (s: string): Blob => new Blob([s], { type: 'text/plain;charset=utf-8' });
const jsonBlob = (s: string): Blob => new Blob([s], { type: 'application/json' });

async function sha256Hex(data: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await data.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** File extension for a recorder mime type. Only the container matters here. */
function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'bin';
}

/** Zero-padded so a directory listing sorts the way the stream runs. Order is meaning. */
function chunkPath(sequence: number, ext: string): string {
  return `chunks/${String(sequence).padStart(6, '0')}.${ext}`;
}

const REMUX_NOTE_REMUXED =
  'capture.* has been rebuilt with a duration and a seek index. It contains the same encoded ' +
  'frames as the segments in chunks/ — nothing was re-encoded. The segments remain the authority.';
const REMUX_NOTE_FLOOR =
  'capture.* is a plain, byte-for-byte, in-order concatenation of the segments in chunks/ — ' +
  'exactly what `cat` would produce. It plays, but carries no duration or seek index, so a ' +
  'player may show 0:00 and may not scrub. This is expected, not damage. The segments remain ' +
  'the authority and reproduce this file exactly.';

function whyFloor(reason: 'not_supported_container' | 'failed' | 'not_attempted', container: string): string {
  if (reason === 'not_supported_container') {
    return (
      `This capture is ${container}. The seamless-playback rebuild currently supports WebM only, ` +
      'so this package ships the raw signed segments and a plain concatenation instead. No ' +
      'evidence is missing — only the convenience of scrubbing. (MP4 support is a known, named ' +
      'future addition.)'
    );
  }
  if (reason === 'failed') {
    return (
      'The seamless-playback rebuild did not complete on this device, so this package ships the ' +
      'raw signed segments and a plain concatenation instead. No evidence is missing.'
    );
  }
  return 'The seamless-playback rebuild was not attempted for this package. No evidence is missing.';
}

function verificationNote(m: EvidenceManifest, captureName: string, chunkCount: number): string {
  return [
    'BLACK BOX — EVIDENCE PACKAGE',
    '',
    `Event:        ${m.eventId}`,
    `Generated:    ${m.generatedAt}`,
    `Format:       ${m.format}`,
    '',
    'HOW TO VERIFY THIS PACKAGE',
    '',
    '  Open  https://blackbox-verify.pages.dev  and drop this ZIP onto the page.',
    '',
    '  It recomputes the SHA-256 of every file here and checks them against the signed',
    '  manifest, then checks the signature against a published key. It runs entirely in',
    '  your browser: nothing is uploaded, and you do not need an account or our',
    '  cooperation. You can also verify by hand — manifest.json lists every hash, and the',
    '  public key is published at',
    '  https://blackboxsentinel.com/.well-known/blackbox-report-public-key.json',
    '',
    'WHAT IS IN HERE',
    '',
    `  chunks/            ${chunkCount} capture segments, exactly as recorded. GROUND TRUTH.`,
    `  ${captureName}${' '.repeat(Math.max(1, 19 - captureName.length))}The same recording as one playable file (see below).`,
    '  location.json      Timestamped position history.',
    '  location.gpx       The same track, for mapping tools.',
    '  origin.json        The write-once record of the moment the alert began.',
    '  situation.json     What the system detected during the incident.',
    '  report.html        The human-readable report, including her own account.',
    '  manifest.json      SHA-256 of every file above, plus the signature.',
    '',
    'PLAYBACK',
    '',
    `  ${m.playback.note.replace(/\n/g, '\n  ')}`,
    '',
    `  ${whyFloor(
      m.playback.remuxed ? 'not_attempted' : m.playback.reason,
      m.playback.container,
    ).replace(/\n/g, '\n  ')}`,
    '',
    '  To rebuild the playable file yourself from the signed segments:',
    '',
    `    macOS/Linux:  cat chunks/* > ${captureName}`,
    `    Windows:      copy /b chunks\\* ${captureName}`,
    '',
    '  The result is byte-identical to the file shipped here, which is why the segments,',
    '  not the assembled file, are what the signature covers.',
    '',
  ].join('\n');
}

/**
 * Assemble the package. The ONLY failure modes are "there is nothing to package" and "the
 * archive cannot honestly be described" — never a missing enhancement.
 */
export async function buildEvidencePackage(input: PackageInput): Promise<PackageResult> {
  if (input.chunks.length === 0) {
    return { ok: false, reason: 'no_chunks' };
  }

  const ordered = [...input.chunks].sort((a, b) => a.sequence - b.sequence);
  const container = extensionFor(ordered[0].mimeType);
  const captureName = `capture.${input.remuxed ? extensionFor(input.remuxed.container) : container}`;

  // The playable single file. Remuxed when D2 could do it; otherwise the plain concatenation,
  // which is correct because MediaRecorder segments are one sliced stream.
  const captureBlob = input.remuxed
    ? input.remuxed.data
    : new Blob(
        ordered.map((c) => c.data),
        { type: ordered[0].mimeType },
      );

  const chunkEntries: ZipEntry[] = ordered.map((c) => ({
    name: chunkPath(c.sequence, container),
    data: c.data,
  }));

  const otherEntries: ZipEntry[] = [
    { name: captureName, data: captureBlob },
    { name: 'location.json', data: jsonBlob(input.locationJson) },
    { name: 'location.gpx', data: new Blob([input.locationGpx], { type: 'application/gpx+xml' }) },
    { name: 'origin.json', data: jsonBlob(input.originJson) },
    { name: 'situation.json', data: jsonBlob(input.situationJson) },
    { name: 'report.html', data: new Blob([input.reportHtml], { type: 'text/html;charset=utf-8' }) },
  ];

  // Hash ground truth and everything else. One file in memory at a time.
  const chunkHashes: PackageFileHash[] = [];
  for (const entry of chunkEntries) {
    chunkHashes.push({ path: entry.name, sha256: await sha256Hex(entry.data), bytes: entry.data.size });
  }
  const fileHashes: PackageFileHash[] = [];
  for (const entry of otherEntries) {
    fileHashes.push({ path: entry.name, sha256: await sha256Hex(entry.data), bytes: entry.data.size });
  }

  const playback: EvidenceManifest['playback'] = input.remuxed
    ? {
        remuxed: true,
        container: input.remuxed.container,
        derivedFromChunks: true,
        note: REMUX_NOTE_REMUXED,
      }
    : {
        remuxed: false,
        reason: input.remuxFailureReason ?? 'not_attempted',
        container: ordered[0].mimeType,
        derivedFromChunks: true,
        note: REMUX_NOTE_FLOOR,
      };

  const manifest: EvidenceManifest = {
    format: PACKAGE_FORMAT,
    eventId: input.eventId,
    generatedAt: new Date(input.generatedAt).toISOString(),
    chunks: chunkHashes,
    files: fileHashes,
    origin: JSON.parse(input.originJson) as unknown,
    playback,
    attestation: input.attestation,
  };

  const verifyTxt = verificationNote(manifest, captureName, ordered.length);
  // VERIFY.txt is itself hashed, so the instructions cannot be quietly rewritten either.
  manifest.files.push({
    path: 'VERIFY.txt',
    sha256: await sha256Hex(textBlob(verifyTxt)),
    bytes: enc.encode(verifyTxt).length,
  });

  const entries: ZipEntry[] = [
    ...chunkEntries,
    ...otherEntries,
    { name: 'VERIFY.txt', data: textBlob(verifyTxt) },
    { name: 'manifest.json', data: jsonBlob(canonicalize(manifest)) },
  ];

  try {
    const zip = await zipStore(entries);
    return {
      ok: true,
      zip,
      manifest,
      filename: `blackbox-evidence-${input.eventId}.zip`,
    };
  } catch (error) {
    if (error instanceof ZipTooLargeError) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: false, reason: 'zip_failed' };
  }
}

/**
 * The hash the server signs — over every file hash, the origin, and the stated playback
 * provenance. A SHA-256, so the server still signs something it cannot invert: zero-knowledge
 * holds and `POST /v1/me/reports/sign` is used exactly as Brief 29 shaped it, unchanged.
 *
 * `attestation` IS EXCLUDED, and it has to be. The attestation is the server's signature over
 * this very hash, so a manifest that hashed its own attestation could never be computed by
 * either side — the hash would depend on the signature that depends on the hash. Excluding it
 * is what makes the chain non-circular, the same property Brief 29 protects by having the
 * server re-derive its own custody facts rather than signing what the device claimed.
 *
 * A verifier must therefore strip `attestation` before recomputing. Nothing is weakened by the
 * exclusion: the attestation carries no claim of its own, only the signature over what remains.
 */
export async function manifestHash(manifest: EvidenceManifest): Promise<string> {
  const signable: Record<string, unknown> = { ...manifest };
  delete signable.attestation;
  return canonicalHash(signable);
}
