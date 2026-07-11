#!/usr/bin/env node
/**
 * Brief 21 §1 — Worker deploy, stamped with the git build so GET /version reports
 * the live build. The deploy-currency print (deploy-pages.mjs) reads it to make a
 * server-newer-than-client split visible immediately.
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
console.log(`Deploying Worker build ${build}…`);
// --var sets a plaintext env var at deploy; the worker serves it at GET /version.
execFileSync('npx', ['wrangler', 'deploy', '--var', `WORKER_BUILD:${build}`], {
  cwd: path.join(ROOT, 'workers/api'),
  stdio: 'inherit',
  shell: true,
});
