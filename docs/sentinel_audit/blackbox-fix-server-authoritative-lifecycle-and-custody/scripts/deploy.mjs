#!/usr/bin/env node
/**
 * Brief 21 §1 — one currency-guarded deploy of the whole product from a single
 * commit: build the PWA with the git build id, deploy the Worker (stamped), then
 * deploy the PWA to production and ASSERT the live build matches. Both live builds
 * are printed at the end, so client and server currency is verifiable in one place.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, shell: true }).toString().trim();
  } catch {
    return 'dev';
  }
}

const build = gitSha();
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, VITE_BUILD_ID: build } });

console.log(`=== Deploy ${build}: build PWA → deploy Worker → deploy PWA (prod, asserted) ===`);
// Build the PWA with the SAME id the Worker is stamped with, so a matched deploy
// shows identical PWA + Worker builds.
run('pnpm', ['-F', 'pwa', 'build']);
run('node', [path.join(ROOT, 'scripts/deploy-worker.mjs')]);
run('node', [path.join(ROOT, 'scripts/deploy-pages.mjs')]);
