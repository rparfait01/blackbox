/**
 * Brief 30 acceptance + guards, run against the ACTUAL BUILT ARTIFACT in `dist/`.
 *
 * This does not test the source and hope the build matches. It extracts the verifier that is
 * really shipped to the page, evaluates it, and drives it with real signed documents — so
 * what passes here is what a visitor's browser will do.
 *
 *   node --test test/verifier.guard.test.mjs      (after: node build.mjs)
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { before, describe, it } from 'node:test';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(HERE, '..', 'dist');

const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
const stepsHtml = readFileSync(join(DIST, 'verification-steps.html'), 'utf8');

/** The verifier exactly as shipped in the page, evaluated here. */
function shippedVerifier() {
  const script = indexHtml.slice(
    indexHtml.indexOf('<script type="module">') + '<script type="module">'.length,
    indexHtml.lastIndexOf('</script>'),
  );
  const iife = script.slice(script.indexOf('var __blackboxVerifier'), script.indexOf('const drop ='));
  const fn = new Function(`${iife}; return __blackboxVerifier;`);
  return fn();
}

/** The shared library, bundled the same way the app consumes it — used only to CREATE
 *  sample documents to feed the shipped verifier. */
async function sharedLib() {
  const out = await build({
    entryPoints: [join(ROOT, 'packages', 'shared', 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
  });
  const dir = mkdtempSync(join(tmpdir(), 'bb-shared-'));
  const file = join(dir, 'shared.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

let verifier;
let shared;
let publishedKey;
let sign;

function sampleEvidence() {
  return {
    formatVersion: 1,
    generatedAt: '2026-07-25T10:00:00.000Z',
    event: {
      eventId: 'evt-sample',
      openedAt: '2026-07-25T09:00:00.000Z',
      closedAt: '2026-07-25T09:30:00.000Z',
      durationMs: 1800000,
      status: 'closed',
      closedBy: 'user',
      tzOffsetMinutes: 540,
      coordinatorEngagedAt: null,
      securedAt: null,
      escalatedAt: null,
      escalationTier: null,
    },
    location: { included: false, pointCount: 0, points: [] },
    notifications: {
      included: true,
      count: 1,
      records: [{ at: '2026-07-25T09:00:05.000Z', kind: 'activation', channel: 'sms', status: 'delivered' }],
    },
    capture: {
      included: true,
      chunkCount: 1,
      totalBytes: 2048,
      firstChunkAt: '2026-07-25T09:00:01.000Z',
      lastChunkAt: '2026-07-25T09:00:01.000Z',
      finalChunkPresent: true,
      chunksVerified: 1,
      chunksFailed: 0,
      chunks: [
        {
          sequence: 0,
          recordedAt: '2026-07-25T09:00:01.000Z',
          bytes: 2048,
          mimeType: 'audio/webm',
          isFinal: true,
          wasEncrypted: true,
          commitment: 'a'.repeat(64),
          commitmentVerified: true,
        },
      ],
    },
    custody: { commitmentCount: 1, commitmentsHash: 'c'.repeat(64), algorithm: 'p256-hkdf-sha256-aes256gcm/v1' },
  };
}

/** Build a real, correctly-signed document. */
async function makeDocument(statement = 'My own words.', mutate = (e) => e) {
  const evidence = mutate(sampleEvidence());
  const hashes = await shared.computeEvidenceHashes(evidence);
  const attestation = {
    format: shared.REPORT_DOCUMENT_FORMAT,
    alg: shared.REPORT_SIGNATURE_ALG,
    eventId: evidence.event.eventId,
    evidenceHash: hashes.evidenceHash,
    renderedHash: hashes.renderedHash,
    commitmentsHash: evidence.custody.commitmentsHash,
    chainHead: 'd'.repeat(64),
    chainSeq: 7,
    signedAt: '2026-07-25T10:00:01.000Z',
  };
  const signature = await sign(shared.canonicalize(attestation));
  return shared.renderReportHtml({ evidence, attestation, signature, publicKey: publishedKey, statement });
}

before(async () => {
  verifier = shippedVerifier();
  shared = await sharedLib();

  // A test keypair standing in for REPORT_SIGNING_KEY, and the page rebuilt to pin it — so
  // the acceptance runs without the production private key ever being present.
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  publishedKey = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  sign = async (data) =>
    Buffer.from(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(data)),
    ).toString('base64');
});

describe('ACCEPTANCE — the four verdicts, through the shipped verifier', () => {
  it('a correctly signed document → CERTIFIED', async () => {
    const result = await verifier.verifyReportDocument(await makeDocument(), publishedKey);
    assert.equal(result.verdict, 'certified');
    assert.match(result.headline, /BLACK BOX CERTIFIED/);
    assert.deepEqual(result.checks, {
      signatureValid: true,
      evidenceHashMatches: true,
      renderedTextMatches: true,
      renderingConsistent: true,
    });
  });

  it('one byte altered in the evidence zone → TAMPERED', async () => {
    const doc = await makeDocument();
    const tampered = doc.replace('Total bytes: 2048', 'Total bytes: 2049');
    assert.notEqual(tampered, doc);
    const result = await verifier.verifyReportDocument(tampered, publishedKey);
    assert.equal(result.verdict, 'tampered');
    assert.match(result.headline, /TAMPERED/);
  });

  it('the embedded evidence data altered → TAMPERED', async () => {
    const doc = await makeDocument();
    const tampered = doc.replace('"totalBytes":2048', '"totalBytes":9999');
    assert.notEqual(tampered, doc);
    assert.equal((await verifier.verifyReportDocument(tampered, publishedKey)).verdict, 'tampered');
  });

  it('ONLY the statement zone altered → still CERTIFIED', async () => {
    const doc = await makeDocument('First draft.');
    const edited = doc.replace('First draft.', 'A much longer account, written weeks later.');
    assert.notEqual(edited, doc);
    const result = await verifier.verifyReportDocument(edited, publishedKey);
    assert.equal(result.verdict, 'certified');
    assert.match(result.statement.note, /not machine-verified/);
  });

  it('a random non-report file → "not a report", gracefully, no crash', async () => {
    for (const junk of ['', '<html><body>shopping list</body></html>', '%PDF-1.4 binary junk', '{"a":1}']) {
      const result = await verifier.verifyReportDocument(junk, publishedKey);
      assert.equal(result.verdict, 'not_a_report', `junk input misclassified: ${junk.slice(0, 20)}`);
      assert.ok(result.headline.length > 0);
    }
  });

  it('a document signed by an ATTACKER key → TAMPERED, because the page pins', async () => {
    const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const attackerKey = Buffer.from(await crypto.subtle.exportKey('spki', attacker.publicKey)).toString('base64');
    const realKey = publishedKey;
    const realSign = sign;
    publishedKey = attackerKey;
    sign = async (data) =>
      Buffer.from(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          attacker.privateKey,
          new TextEncoder().encode(data),
        ),
      ).toString('base64');
    const forged = await makeDocument('', (e) => ({ ...e, event: { ...e.event, status: 'escalated' } }));
    publishedKey = realKey;
    sign = realSign;

    // Self-consistent, so it verifies against its OWN key...
    assert.equal((await verifier.verifyReportDocument(forged, attackerKey)).verdict, 'certified');
    // ...and is exposed against the published one. This is why the page pins.
    assert.equal((await verifier.verifyReportDocument(forged, realKey)).verdict, 'tampered');
  });
});

describe('GUARD — nothing is uploaded, nothing is stored', () => {
  it('the page makes no network call and touches no storage API', () => {
    for (const [name, html] of Object.entries({ indexHtml, stepsHtml })) {
      assert.doesNotMatch(html, /fetch\s*\(/, `${name} must not fetch`);
      assert.doesNotMatch(html, /XMLHttpRequest|sendBeacon|WebSocket|EventSource/, `${name} must not transmit`);
      assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${name} must not store`);
    }
  });

  it('loads nothing from a third party — it is genuinely self-contained and offline-capable', () => {
    // Any absolute or protocol-relative external reference would break the offline promise.
    const external = [...indexHtml.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]*"/g)].map((m) => m[0]);
    assert.deepEqual(external, [], `external references found: ${external.join(', ')}`);
    assert.doesNotMatch(indexHtml, /@import|googleapis|cdn\./);
  });

  it('says plainly that the file stays on the visitor’s device', () => {
    assert.match(indexHtml, /Your file stays on your device/);
    assert.match(indexHtml, /never uploaded/);
  });
});

describe('GUARD — public key only, and it is the published one', () => {
  it('no private key material anywhere in the built output', () => {
    for (const [name, html] of Object.entries({ indexHtml, stepsHtml })) {
      assert.doesNotMatch(html, /PRIVATE KEY|REPORT_SIGNING_KEY/, `${name} must not carry private material`);
      // A JWK private key would carry a "d" parameter.
      assert.doesNotMatch(html, /"d"\s*:/, `${name} must not carry a JWK private scalar`);
    }
    const jwk = JSON.parse(readFileSync(join(DIST, 'blackbox-report-public-key.jwk.json'), 'utf8'));
    assert.equal(jwk.d, undefined, 'published JWK must be the PUBLIC half only');
    assert.equal(jwk.crv, 'P-256');
    assert.deepEqual(jwk.key_ops, ['verify']);
  });

  it('pins exactly the key the signer publishes in wrangler.toml', () => {
    const toml = readFileSync(join(ROOT, 'workers', 'api', 'wrangler.toml'), 'utf8');
    const declared = toml.match(/^REPORT_PUBLIC_KEY\s*=\s*"([^"]+)"/m)[1];
    assert.ok(indexHtml.includes(declared), 'the page must pin the published signing key');
    const pem = readFileSync(join(DIST, 'blackbox-report-public-key.pem'), 'utf8');
    assert.equal(pem.replace(/-----[^-]+-----|\s/g, ''), declared, 'PEM must match the published key');
  });

  it('publishes the algorithm and the steps, so the page is not required', () => {
    assert.match(indexHtml, /ECDSA P-256 with SHA-256/);
    assert.match(indexHtml, /verification-steps\.html/);
    assert.match(stepsHtml, /raw <i>r‖s<\/i> \(P1363\)|raw r‖s/);
    assert.match(stepsHtml, /openssl/);
  });
});

describe('GUARD — separate from the app', () => {
  it('the verifier package depends on no app code', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined, 'the verifier must have no runtime dependencies');
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['esbuild', 'wrangler']);
  });

  it('needs no backend: the built output is static files only', () => {
    // If verification ever required a server, an endpoint would have to appear here.
    assert.doesNotMatch(indexHtml, /\/v1\/|workers\.dev|api\./);
  });
});
