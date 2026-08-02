#!/usr/bin/env node
/**
 * Brief 21 §1 — production PWA deploy with a currency assertion.
 *
 * Deploys the built dist to the PRODUCTION branch (never Preview), then asserts
 * that BOTH the live PWA and the live Worker report the build just shipped. A PWA
 * mismatch means the deploy did NOT reach production (stale cache, or it landed as
 * a Preview) — the exact failure that let production run a 2-week-old client. A
 * Worker mismatch means a server/client SPLIT. Brief 0 hardened both halves: either
 * one failing — including an unreachable or erroring Worker /version, which fails
 * CLOSED, never 'unknown' — exits non-zero, and the success line prints only after
 * both verify. Currency lives in assert-currency.mjs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertDeployCurrencyOrExit } from './assert-currency.mjs';
import { API_ORIGIN_VAR, deployTarget } from './api-origin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/pwa/dist');
// §B — targets come from TRACKED per-environment config, so the origin the artifact
// was built against and the origin currency is asserted against cannot disagree.
const TARGET = deployTarget('production');
const PROD_URL = TARGET.pwaOrigin;
const WORKER_URL = TARGET.apiOrigin;
const PROJECT = TARGET.pagesProject;
// The Pages project's PRODUCTION branch. Deploying to anything else lands as a
// Preview that never reaches blackbox-pwa.pages.dev — the whole point of this guard.
const PROD_BRANCH = TARGET.pagesBranch;

const versionFile = path.join(DIST, 'version.json');
if (!existsSync(versionFile)) {
  console.error(`✗ ${versionFile} not found — run \`pnpm -F pwa build\` first.`);
  process.exit(1);
}
const expected = JSON.parse(readFileSync(versionFile, 'utf8')).build;

/**
 * Brief 35 §A — PROVE THE ORIGIN IS IN THE ARTIFACT, not merely in the environment
 * that ran the build. The vite gate refuses to compile without a valid origin, but
 * this deploy step can also be run on its own against a `dist/` produced by some other
 * invocation (`vite build --mode …`, a stale directory, another shell). Reading the
 * bytes that are about to be published is the only claim that survives all of those.
 *
 * If the origin is not in the bundle, the client has no alert path — and it is exactly
 * the failure that currency checking alone reported as green.
 */
function assertOriginInArtifact() {
  const assets = path.join(DIST, 'assets');
  const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  const found = files.some((f) => readFileSync(path.join(assets, f), 'utf8').includes(TARGET.apiOrigin));
  if (!found) {
    console.error(
      `\n✗ ORIGIN MISSING FROM THE BUILD: no bundled asset in ${assets} contains '${TARGET.apiOrigin}'.\n` +
        `  This artifact has NO ALERT PATH — activation would show an active alert while creating\n` +
        `  no event, notifying nobody and uploading nothing. Refusing to publish it.\n` +
        `  Rebuild through \`pnpm deploy\` (which sets ${API_ORIGIN_VAR} from config/deploy-targets.json).`,
    );
    process.exit(1);
  }
  console.log(`✓ built artifact contains the production API origin (${TARGET.apiOrigin}).`);
}
assertOriginInArtifact();

console.log(`Deploying PWA build ${expected} → production (branch=${PROD_BRANCH})…`);

// Pin the target: ALWAYS the production branch. There is no code path here that
// leaves a production deploy as Preview-only.
// RUN FROM apps/pwa, WHERE WRANGLER IS PINNED. This used to run with `cwd: ROOT`, and the repo
// root has no wrangler in its node_modules — so `npx` silently fetched one from the registry.
// The PWA half of every deploy was therefore performed by an UNPINNED binary: 4.99.0 from the
// network while package.json pinned 4.118.0. The version that publishes the client was whatever
// the registry served that morning, which is neither reproducible nor reviewable, and it
// downloaded a toolchain mid-deploy every time. apps/pwa has wrangler as a devDependency, so
// running from there uses the version this repo actually declares.
execFileSync(
  'npx',
  ['wrangler', 'pages', 'deploy', 'dist', `--project-name=${PROJECT}`, `--branch=${PROD_BRANCH}`],
  { cwd: path.join(ROOT, 'apps/pwa'), stdio: 'inherit', shell: true },
);

// Poll BOTH live endpoints for edge propagation, then assert. Both halves must
// prove the expected build against the LIVE endpoints, and an unreachable/stale/
// erroring worker fails CLOSED — the success line prints only if both verify.
// (Brief 0 — deploy hardening. Logic lives in assert-currency.mjs so its failure
// paths are provable without a real deploy: scripts/verify-hardening.mjs.)
await assertDeployCurrencyOrExit({ expected, prodUrl: PROD_URL, workerUrl: WORKER_URL });
