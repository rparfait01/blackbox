/**
 * Produce SAMPLE certified reports, signed with the real report-signing key, so the live
 * verifier page can be exercised before Brief 29 has generated a real one (Brief 30 §0 — a
 * calculator works before anyone types a number).
 *
 * These samples are PLACEHOLDER CONTENT, not evidence about anyone. They carry an obviously
 * fake event id and a statement that says so, precisely so a sample can never be mistaken
 * for a real survivor's record.
 *
 *   node scripts/make-sample.mjs <private-key-pkcs8-b64> <out-dir>
 *
 * The private key is passed in and never stored here.
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const [privateKeyB64, outDir] = process.argv.slice(2);
if (!privateKeyB64 || !outDir) {
  console.error('usage: node scripts/make-sample.mjs <private-key-pkcs8-b64> <out-dir>');
  process.exit(1);
}

const out = await build({
  entryPoints: [join(ROOT, 'packages', 'shared', 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const tmp = join(mkdtempSync(join(tmpdir(), 'bb-sample-')), 'shared.mjs');
writeFileSync(tmp, out.outputFiles[0].text);
const shared = await import(pathToFileURL(tmp).href);

const key = await crypto.subtle.importKey(
  'pkcs8',
  Buffer.from(privateKeyB64, 'base64'),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);
const publicKeyB64 = process.env.REPORT_PUBLIC_KEY;
if (!publicKeyB64) {
  console.error('set REPORT_PUBLIC_KEY to the published SPKI base64');
  process.exit(1);
}

const evidence = {
  formatVersion: 1,
  generatedAt: '2026-07-25T12:00:00.000Z',
  event: {
    eventId: 'SAMPLE-NOT-A-REAL-EVENT',
    openedAt: '2026-07-25T11:00:00.000Z',
    closedAt: '2026-07-25T11:26:40.000Z',
    durationMs: 1600000,
    status: 'closed',
    closedBy: 'user',
    tzOffsetMinutes: 540,
    coordinatorEngagedAt: '2026-07-25T11:02:10.000Z',
    securedAt: null,
    escalatedAt: null,
    escalationTier: null,
  },
  location: {
    included: true,
    pointCount: 2,
    points: [
      { at: '2026-07-25T11:00:20.000Z', lat: 35.6812, lon: 139.7671, accuracyM: 12 },
      { at: '2026-07-25T11:05:20.000Z', lat: 35.6819, lon: 139.7683, accuracyM: 9 },
    ],
  },
  notifications: {
    included: true,
    count: 2,
    records: [
      { at: '2026-07-25T11:00:04.000Z', kind: 'activation', channel: 'sms', status: 'delivered' },
      { at: '2026-07-25T11:00:06.000Z', kind: 'activation', channel: 'line', status: 'delivered' },
    ],
  },
  capture: {
    included: true,
    chunkCount: 3,
    totalBytes: 196608,
    firstChunkAt: '2026-07-25T11:00:01.000Z',
    lastChunkAt: '2026-07-25T11:00:03.000Z',
    finalChunkPresent: true,
    chunksVerified: 3,
    chunksFailed: 0,
    chunks: [0, 1, 2].map((i) => ({
      sequence: i,
      recordedAt: `2026-07-25T11:00:0${i + 1}.000Z`,
      bytes: 65536,
      mimeType: 'audio/webm',
      isFinal: i === 2,
      wasEncrypted: true,
      commitment: `${String(i)}${'0123456789abcdef'.repeat(4)}${'0'.repeat(63 - 64 + 64)}`.slice(0, 64),
      commitmentVerified: true,
    })),
  },
  custody: {
    commitmentCount: 3,
    commitmentsHash: 'f'.repeat(64),
    algorithm: 'p256-hkdf-sha256-aes256gcm/v1',
  },
};

const STATEMENT =
  'THIS IS A SAMPLE DOCUMENT. It was generated to test the BLACK BOX verification page and ' +
  'does not describe any real person or incident. In a real report, this section holds the ' +
  "survivor's own words — it is not signed, not machine-verified, and she can revise it at " +
  'any time without affecting the certification of the evidence above.';

const hashes = await shared.computeEvidenceHashes(evidence);
const attestation = {
  format: shared.REPORT_DOCUMENT_FORMAT,
  alg: shared.REPORT_SIGNATURE_ALG,
  eventId: evidence.event.eventId,
  evidenceHash: hashes.evidenceHash,
  renderedHash: hashes.renderedHash,
  commitmentsHash: evidence.custody.commitmentsHash,
  chainHead: 'a1b2c3d4'.repeat(8),
  chainSeq: 12,
  signedAt: '2026-07-25T12:00:01.000Z',
};
const signature = Buffer.from(
  await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(shared.canonicalize(attestation)),
  ),
).toString('base64');

const good = shared.renderReportHtml({ evidence, attestation, signature, publicKey: publicKeyB64, statement: STATEMENT });
writeFileSync(join(outDir, 'SAMPLE-certified.html'), good);

// Same document with ONE character of the visible evidence changed — should read TAMPERED.
const tampered = good.replace('Total bytes: 196608', 'Total bytes: 196609');
if (tampered === good) throw new Error('tamper target not found — sample would not demonstrate TAMPERED');
writeFileSync(join(outDir, 'SAMPLE-tampered.html'), tampered);

// Same document with only the STATEMENT rewritten — should still read CERTIFIED.
const restated = good.replace(STATEMENT, 'A completely different statement, written later. Still a sample.');
if (restated === good) throw new Error('statement not found — sample would not demonstrate the unsigned zone');
writeFileSync(join(outDir, 'SAMPLE-statement-edited.html'), restated);

console.log('samples written to', outDir);
