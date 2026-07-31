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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertDeployCurrencyOrExit } from './assert-currency.mjs';

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

// Poll BOTH live endpoints for edge propagation, then assert. Both halves must
// prove the expected build against the LIVE endpoints, and an unreachable/stale/
// erroring worker fails CLOSED — the success line prints only if both verify.
// (Brief 0 — deploy hardening. Logic lives in assert-currency.mjs so its failure
// paths are provable without a real deploy: scripts/verify-hardening.mjs.)
await assertDeployCurrencyOrExit({ expected, prodUrl: PROD_URL, workerUrl: WORKER_URL });
