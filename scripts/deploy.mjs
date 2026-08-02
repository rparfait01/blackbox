#!/usr/bin/env node
/**
 * Brief 21 §1 + Brief 35 §B/§C — one currency-guarded deploy of the whole product
 * from a single commit.
 *
 * DEPLOY CURRENCY REQUIRES THREE CONDITIONS, ALL ENFORCED BEFORE THE PRODUCT IS
 * TRUSTED (Brief 021 §1, as corrected by Brief 35):
 *
 *   1. the PWA and Worker build ids match          (assert-currency.mjs)
 *   2. the built artifact contains a valid HTTPS production API origin  (§A/§B, here
 *      and in deploy-pages.mjs)
 *   3. a canary round trip against that origin completes                (§C, canary.mjs)
 *
 * A build id match alone does NOT establish currency. It never did — it only ever
 * proved that two halves were built from the same commit, which is equally true of a
 * commit whose client cannot reach its server at all. That is exactly the state this
 * repo was one clean checkout away from publishing: `.env` is gitignored, so a build
 * on any machine without it produced a PWA with an empty API origin, a fully silent
 * alert path, and a green deploy.
 *
 * ORDER IS LOAD-BEARING. Validate the origin BEFORE building (nothing is produced from
 * a bad config), build the PWA with it, deploy the Worker, deploy the PWA and assert
 * currency, then prove the whole path end to end with the canary. The first gate that
 * fails stops everything after it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { randomBytes } from 'node:crypto';

import { API_ORIGIN_VAR, deployTarget } from './api-origin.mjs';
import { gateRequestCount } from './assert-currency.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, shell: true }).toString().trim();
  } catch {
    return 'dev';
  }
}

// §B — the origin comes from TRACKED config, is validated before anything is built,
// and is REPORTED. A deploy that cannot say which backend it built against is a deploy
// that cannot be checked. `deployTarget` throws (non-zero exit) on a missing, empty,
// non-HTTPS or non-routable value.
const target = deployTarget('production');

/**
 * §C — the nonce that makes the canary part of THIS gate run and nothing else. Minted here,
 * passed by environment, never written to disk. Without it the canary refuses to count.
 */
const GATE_NONCE = randomBytes(24).toString('hex');

/**
 * §F — THE GATE COSTS REQUESTS, AND UNDER QUOTA PRESSURE THAT IS SELF-DEFEATING.
 *
 * Verifying a deploy spends real requests against the same plan limit whose exhaustion takes
 * the alert path down. Discovering mid-deploy that there was no budget for the verification is
 * how a correct deploy gets abandoned and finished by hand. So the gate asks FIRST, with one
 * request, and refuses to start if the headroom is not there.
 */
const HEADROOM_REFUSE_ABOVE = 0.9;

async function assertHeadroomOrRefuse(apiOrigin) {
  const token = (() => {
    try {
      return readFileSync(path.join(ROOT, 'workers/admin_token.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  if (!token) {
    console.log('    headroom: SKIPPED (no admin credential to query it)');
    return;
  }
  try {
    const res = await fetch(`${apiOrigin}/v1/admin/encryption/readiness`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.log(`    headroom: UNKNOWN (readiness returned ${res.status})`);
      return;
    }
    const body = await res.json();
    const r = body?.requests;
    if (!r || !r.configured) {
      console.log('    headroom: NOT MEASURED (no analytics token configured — see Brief 33 Fix A §F)');
      return;
    }
    console.log(`    headroom: ${r.summary}`);
    if (r.usedFraction != null && r.usedFraction >= HEADROOM_REFUSE_ABOVE) {
      console.error(
        [
          '',
          `✗ DEPLOY REFUSED: request headroom is ${Math.round(r.usedFraction * 100)}% of the plan limit.`,
          '  The gate itself spends requests, and the alert path fails when the limit is reached.',
          '  This is BILLING, not infrastructure. Raise the plan or wait for the daily reset.',
        ].join('\n'),
      );
      process.exit(1);
    }
  } catch (error) {
    console.log(`    headroom: UNKNOWN (${String(error).slice(0, 80)})`);
  }
}

const build = gitSha();
const run = (cmd, args, extraEnv = {}) =>
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    // The deploy pipeline's value WINS over any local .env — Vite gives process.env
    // precedence for VITE_-prefixed keys. An operator's stale .env cannot redirect a
    // production build.
    env: { ...process.env, VITE_BUILD_ID: build, [API_ORIGIN_VAR]: target.apiOrigin, ...extraEnv },
  });

console.log(`=== Deploy ${build}: build PWA → deploy Worker → deploy PWA (prod, asserted) → canary ===`);
console.log(`    API origin (config/deploy-targets.json → production): ${target.apiOrigin}`);
console.log(`    PWA origin: ${target.pwaOrigin}  (Pages project ${target.pagesProject}, branch ${target.pagesBranch})`);

await assertHeadroomOrRefuse(target.apiOrigin);

// Build the PWA with the SAME id the Worker is stamped with, so a matched deploy
// shows identical PWA + Worker builds — and with the validated origin baked in.
run('pnpm', ['-F', 'pwa', 'build']);
run('node', [path.join(ROOT, 'scripts/deploy-worker.mjs')]);
run('node', [path.join(ROOT, 'scripts/deploy-pages.mjs')]);

// §C — THE CANARY. Build ids matching proves the two halves came from one commit; it
// proves nothing about whether the client can reach the server. This does: a full
// round trip on a dedicated canary account, on the origin just published, with
// dispatch suppressed server-side and the event purged afterwards. A deploy is not
// finished until a transaction has actually completed against production.
run('node', [path.join(ROOT, 'scripts/canary.mjs'), '--environment=production', `--build=${build}`], {
  BBX_GATE_NONCE: GATE_NONCE,
});

// §F — name the number. The gate's own cost is not a rounding error when the limit it is
// measured against is what takes the alert path down.
console.log(`\n[gate] currency poll issued ${gateRequestCount()} request(s); the canary issues ~18.`);
