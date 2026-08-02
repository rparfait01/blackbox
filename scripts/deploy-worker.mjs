#!/usr/bin/env node
/**
 * Brief 21 §1 — Worker deploy, stamped with the git build so GET /version reports
 * the live build. The deploy-currency print (deploy-pages.mjs) reads it to make a
 * server-newer-than-client split visible immediately.
 *
 * BOTH environments ship from the same commit, and that is load-bearing.
 *
 * The acceptance suite now runs against STAGING (its own D1 and R2, so a test run can
 * never touch production data). That severance is only worth anything if staging is
 * running the SAME code as the commit under test — a suite pointed at a stale staging
 * worker is worse than no suite, because it reports green for code that was never
 * exercised. So staging is deployed here, from the same build id, every time.
 *
 * Staging is deployed FIRST: if it fails, production has not moved yet. Only the
 * production half is currency-asserted against the live PWA (deploy-pages.mjs);
 * staging carries the same stamp so the suite can check it for itself.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'workers/api');

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, shell: true }).toString().trim();
  } catch {
    return 'dev';
  }
}

const build = gitSha();

// --var sets a plaintext env var at deploy; the worker serves it at GET /version.
console.log(`Deploying STAGING Worker build ${build} (blackbox-api-staging → blackbox-test)…`);
execFileSync('npx', ['wrangler', 'deploy', '--env', 'staging', '--var', `WORKER_BUILD:${build}`], {
  cwd: API,
  stdio: 'inherit',
  shell: true,
});

// `--env=""` NAMES THE TOP-LEVEL ENVIRONMENT EXPLICITLY (Brief 35 Fix A §A, wrangler 4.x).
// A bare `wrangler deploy` alongside a defined `[env.staging]` is ambiguous, and wrangler 4 warns
// that it risks "unintentional changes to the wrong environment". The two environments here are
// production and the severed staging that the acceptance suite writes to — precisely the pair
// where an ambiguous default is worth removing rather than relying on.
console.log(`Deploying PRODUCTION Worker build ${build}…`);
execFileSync('npx', ['wrangler', 'deploy', '--env=""', '--var', `WORKER_BUILD:${build}`], {
  cwd: API,
  stdio: 'inherit',
  shell: true,
});
