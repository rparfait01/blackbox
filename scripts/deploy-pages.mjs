#!/usr/bin/env node
/**
 * Brief 21 §1 — production PWA deploy with a currency assertion.
 *
 * Deploys the built dist to the PRODUCTION branch (never Preview), then asserts the
 * LIVE production build hash equals the one just built. A mismatch means the deploy
 * did NOT reach production (stale cache, or it landed as a Preview) — the exact
 * failure that let production run a 2-week-old client. On mismatch this exits
 * non-zero and prints the diff, so it can never pass silently. Also prints the live
 * PWA + Worker builds so a server-newer-than-client split is visible immediately.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/pwa/dist');
const PROD_URL = 'https://blackbox-pwa.pages.dev';
const WORKER_URL = 'https://blackbox-api.stillpoint-dev.workers.dev';
const PROJECT = 'blackbox-pwa';
// The Pages project's PRODUCTION branch. Deploying to anything else lands as a
// Preview that never reaches blackbox-pwa.pages.dev — the whole point of this guard.
const PROD_BRANCH = 'master';

const versionFile = path.join(DIST, 'version.json');
if (!existsSync(versionFile)) {
  console.error(`✗ ${versionFile} not found — run \`pnpm -F pwa build\` first.`);
  process.exit(1);
}
const expected = JSON.parse(readFileSync(versionFile, 'utf8')).build;
console.log(`Deploying PWA build ${expected} → production (branch=${PROD_BRANCH})…`);

// Pin the target: ALWAYS the production branch. There is no code path here that
// leaves a production deploy as Preview-only.
execFileSync(
  'npx',
  ['wrangler', 'pages', 'deploy', 'apps/pwa/dist', `--project-name=${PROJECT}`, `--branch=${PROD_BRANCH}`],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

async function liveJson(url) {
  const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// Poll for edge propagation, then assert.
let live = null;
for (let i = 0; i < 12; i += 1) {
  try {
    live = (await liveJson(`${PROD_URL}/version.json`)).build;
    if (live === expected) break;
  } catch {
    /* still propagating */
  }
  await new Promise((r) => setTimeout(r, 3000));
}

let worker = 'unknown';
try {
  worker = (await liveJson(`${WORKER_URL}/version`)).version;
} catch {
  /* an older worker without /version */
}

console.log('\n──────────── deploy currency ────────────');
console.log(`PWA  committed : ${expected}`);
console.log(`PWA  live      : ${live ?? '(unreachable)'}`);
console.log(`Worker live    : ${worker}`);
console.log('─────────────────────────────────────────');

if (live !== expected) {
  console.error(`\n✗ CURRENCY MISMATCH: production PWA is '${live}', expected '${expected}'.`);
  console.error('  The deploy did NOT reach production (stale cache or wrong target). Failing loud.');
  process.exit(1);
}
if (worker !== 'unknown' && worker !== expected) {
  console.warn(`\n⚠ Worker (${worker}) and PWA (${expected}) builds differ — a server/client split. Redeploy the lagging side.`);
}
console.log('\n✓ production PWA matches the committed build.');
