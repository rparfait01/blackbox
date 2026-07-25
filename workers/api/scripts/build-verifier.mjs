/**
 * Bundle the SHARED verifier into a standalone browser script (Brief 29 §3).
 *
 * The verification page checks a document entirely in the visitor's browser — the file is
 * never uploaded, so there is nothing for BLACK BOX to store. That requires the verifier to
 * be present as page script. This bundles the ONE shared implementation into that script
 * rather than letting a second copy be hand-written for the browser (§-1 [A]: reuses, never
 * re-implements). One verifier, three runtimes.
 *
 * The output is committed so the Worker has no build-time dependency at deploy. A stale
 * bundle would mean the page verifies with different logic than everything else, so
 * verifier-bundle.guard.test.ts regenerates and fails if the committed file has drifted.
 *
 *   pnpm -F @blackbox/api build:verifier
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'shared', 'src', 'report-verify.ts');
const OUT_DIR = join(HERE, '..', 'src', 'generated');
const OUT_FILE = join(OUT_DIR, 'verifier-bundle.ts');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * The shared certified-report verifier (packages/shared/src/report-verify.ts), bundled for
 * the public verification page so a document can be checked entirely in the visitor's
 * browser without ever being uploaded (Brief 29 §3).
 *
 * Regenerate with:  pnpm -F @blackbox/api build:verifier
 * Drift is caught by verifier-bundle.guard.test.ts.
 */
`;

/** Bundle to an IIFE that assigns the entry point onto the module scope of the page
 *  script, so the inlined source can call verifyReportDocument directly. */
export async function bundleVerifier() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: '__blackboxVerifier',
    platform: 'browser',
    target: 'es2022',
    write: false,
    legalComments: 'none',
  });
  const js = result.outputFiles[0].text.trim();
  // The page script calls verifyReportDocument(...) directly; expose it from the IIFE.
  return `${js}\nconst verifyReportDocument = __blackboxVerifier.verifyReportDocument;`;
}

export function renderModule(source) {
  return `${HEADER}\nexport const VERIFIER_BUNDLE = ${JSON.stringify(source)};\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const source = await bundleVerifier();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, renderModule(source), 'utf8');
  console.log(`verifier bundle written: ${OUT_FILE} (${source.length} bytes of script)`);
}
