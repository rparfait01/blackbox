/**
 * Build the STANDALONE report verifier (Brief 30).
 *
 * Output: `verifier/dist/` — a handful of static files, deployable anywhere. No backend, no
 * D1, no Worker route, no app coupling. Cloudflare Pages is just where we happen to put it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not import app code. It pulls the verification LOGIC from `packages/shared`
 *     (a library) at build time, and nothing from the PWA or the Worker.
 *   - It embeds the PUBLIC key only. The private key is a Worker secret and appears nowhere
 *     in this bundle — asserted below, and again in verifier.guard.test.mjs.
 *
 * WHY IT BUNDLES THE SHARED VERIFIER INSTEAD OF ITS OWN COPY. A hand-written second verifier
 * is the one failure mode that matters here: it would drift from the signer and start
 * printing CERTIFIED or TAMPERED for the wrong reasons. There is exactly one verification
 * implementation, compiled into three places.
 *
 * WHY THE PUBLIC KEY IS READ FROM wrangler.toml. That file is where the signer publishes it.
 * Reading it here (a build-time text read, not an import) makes it impossible for the
 * verifier to pin a different key than the one reports are signed against — a mismatch would
 * make every genuine report read as TAMPERED.
 *
 *   node verifier/build.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(HERE, 'dist');
const WRANGLER = join(ROOT, 'workers', 'api', 'wrangler.toml');

/** The published report-verification key, from where the signer publishes it. */
function publishedKey() {
  const toml = readFileSync(WRANGLER, 'utf8');
  const match = toml.match(/^REPORT_PUBLIC_KEY\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('REPORT_PUBLIC_KEY not found in workers/api/wrangler.toml — cannot build a verifier with no key');
  }
  return match[1];
}

/** The shared verifier, bundled for the browser. */
async function verifierBundle() {
  const result = await build({
    entryPoints: [join(ROOT, 'packages', 'shared', 'src', 'report-verify.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__blackboxVerifier',
    platform: 'browser',
    target: 'es2022',
    minify: false, // readable on purpose: anyone may audit what this page actually does
    write: false,
    legalComments: 'none',
  });
  return `${result.outputFiles[0].text.trim()}\nconst verifyReportDocument = __blackboxVerifier.verifyReportDocument;`;
}

function pem(spkiB64) {
  return `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** SPKI base64 → JWK, so a verifier can import the key without parsing DER. For P-256 the
 *  uncompressed point is the trailing 65 bytes: 0x04 ‖ X(32) ‖ Y(32). */
function jwk(spkiB64) {
  const der = Buffer.from(spkiB64, 'base64');
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) throw new Error('unexpected EC point encoding in REPORT_PUBLIC_KEY');
  const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(point.subarray(1, 33)),
    y: b64url(point.subarray(33, 65)),
    use: 'sig',
    alg: 'ES256',
    key_ops: ['verify'],
  };
}

const key = publishedKey();
const verifier = await verifierBundle();

const page = readFileSync(join(HERE, 'src', 'page.html'), 'utf8')
  .replaceAll('__PUBLIC_KEY__', key)
  .replace('__VERIFIER__', verifier);

const steps = readFileSync(join(HERE, 'src', 'verification-steps.html'), 'utf8').replaceAll('__PUBLIC_KEY__', key);

// A leaked private key means forgeable certifications. Fail the BUILD, loudly, rather than
// ever shipping one — a check that costs nothing and would have caught a catastrophe.
for (const [name, content] of Object.entries({ page, steps })) {
  if (/PRIVATE KEY|"d"\s*:|REPORT_SIGNING_KEY/.test(content)) {
    throw new Error(`refusing to build: ${name} appears to contain private key material`);
  }
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), page);
writeFileSync(join(DIST, 'verification-steps.html'), steps);
writeFileSync(join(DIST, 'blackbox-report-public-key.pem'), pem(key));
writeFileSync(join(DIST, 'blackbox-report-public-key.jwk.json'), `${JSON.stringify(jwk(key), null, 2)}\n`);
// No analytics, no external requests, no third-party anything. Say so machine-readably too.
writeFileSync(join(DIST, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors *\n`);

console.log(`verifier built → ${DIST}`);
console.log(`  key pinned: ${key.slice(0, 24)}… (${key.length} chars)`);
console.log(`  page: ${(page.length / 1024).toFixed(1)} kB, self-contained`);
