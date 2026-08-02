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
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { randomBytes } from 'node:crypto';

import { API_ORIGIN_VAR, deployTarget } from './api-origin.mjs';
import { HEADROOM, headroomVerdict, readHeadroom } from './headroom.mjs';
import { assertVaultLock, parseLockRules, provisionCommand, readVaultLock } from './vault-lock.mjs';
import { checkDeployToolchain } from './toolchain.mjs';

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

/** The production custody vault. Staging seals into blackbox-vault-test and is locked separately. */
const VAULT_BUCKET = 'blackbox-vault';

/**
 * §C — the nonce that makes the canary part of THIS gate run and nothing else. Minted here,
 * passed by environment, never written to disk. Without it the canary refuses to count.
 */
const GATE_NONCE = randomBytes(24).toString('hex');

/**
 * §F — the shared request ledger. The polling happens inside child processes, so an in-memory
 * counter in THIS process can only ever report zero, which is what the first real deploy under
 * this brief did. Every process that issues a gate request appends here; the total is read back
 * at the end. Named per run, in the OS temp dir, and unlinked when the deploy finishes.
 */
const COST_FILE = path.join(tmpdir(), `bbx-gate-cost-${GATE_NONCE.slice(0, 12)}.log`);
writeFileSync(COST_FILE, '');

/**
 * §C — the run marker the canary CONSUMES. Written here, deleted by the canary on first read, so
 * a nonce cannot be replayed to finish a stumbled gate by hand. Gitignored; it never outlives a run.
 */
writeFileSync(path.join(ROOT, '.gate-run'), JSON.stringify({ nonce: GATE_NONCE, build: gitSha(), at: Date.now() }));

/**
 * §F — THE GATE COSTS REQUESTS, AND UNDER QUOTA PRESSURE THAT IS SELF-DEFEATING.
 *
 * Verifying a deploy spends real requests against the same plan limit whose exhaustion takes
 * the alert path down. Discovering mid-deploy that there was no budget for the verification is
 * how a correct deploy gets abandoned and finished by hand. So the gate asks FIRST, with one
 * request, and refuses to start if the headroom is not there.
 */
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
  const verdict = headroomVerdict(await readHeadroom(apiOrigin, token));
  if (verdict.state === HEADROOM.REFUSE) {
    console.error(verdict.message);
    process.exit(1);
  }
  console.log(`    ${verdict.message}`);
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
    env: { ...process.env, VITE_BUILD_ID: build, [API_ORIGIN_VAR]: target.apiOrigin, BBX_GATE_COST_FILE: COST_FILE, ...extraEnv },
  });

console.log(`=== Deploy ${build}: build PWA → deploy Worker → deploy PWA (prod, asserted) → canary ===`);
console.log(`    API origin (config/deploy-targets.json → production): ${target.apiOrigin}`);
console.log(`    PWA origin: ${target.pwaOrigin}  (Pages project ${target.pagesProject}, branch ${target.pagesBranch})`);

/**
 * RATIFIED FROM §A — REPORT THE TOOLCHAIN THAT WILL ACTUALLY RUN, AND REFUSE A MISMATCH.
 *
 * The client half of every deploy was published by a wrangler fetched from the registry, because
 * `npx` was invoked from a directory that did not declare it. Nothing failed and nothing warned;
 * the declared version and the running version were simply never printed next to each other.
 * Same class as the phantom `0 request(s)` line — a pipeline that cannot state what it did.
 */
function assertToolchainOrRefuse() {
  const results = checkDeployToolchain(ROOT);
  for (const r of results) {
    console.log(`    toolchain: ${r.dir} ${r.tool}@${r.installed ?? '(none)'} (declared ${r.declared ?? '(undeclared)'})`);
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.error(
      [
        '',
        '✗ DEPLOY REFUSED: the toolchain that would run is not the toolchain this repo declares.',
        ...bad.map((r) => `    · ${r.problem}`),
        '',
        '  A tool resolved from the network is not a pinned dependency, and a deploy that cannot',
        '  say which version published it cannot be reproduced or reviewed.',
      ].join('\n'),
    );
    process.exit(1);
  }
}

assertToolchainOrRefuse();

/**
 * Brief 35 Fix A §C (corrected) — THE DEPLOY VERIFIES ITS OWN PRECONDITION.
 *
 * The gate used to depend on an operator typing `pnpm test && pnpm deploy`. I typed `;` instead
 * of `&&` and deployed with a failing test. Nothing was wrong with the test, the tooling, or the
 * intent — the gate was simply expressed in shell operator precedence, which is not a gate. It is
 * the same defect as a gate a human can finish by hand: a control whose enforcement depends on
 * the care of the person it is meant to constrain.
 *
 * So the deploy RUNS the verification itself, in this process, before anything is published.
 * There is no flag to skip it and no environment variable that shortens it, for the same reason
 * `--skip` does not exist on the canary. If it fails, `execFileSync` throws and nothing ships.
 *
 * It costs a couple of minutes per deploy. That is the correct price: the alternative is a
 * pipeline whose safety property is "the operator remembered", and this session is the evidence
 * that the operator does not always remember.
 */
console.log('\n─────────── verification (typecheck · lint · test · build) ───────────');
try {
  run('pnpm', ['verify']);
} catch {
  console.error(
    [
      '',
      '✗ DEPLOY REFUSED: verification did not pass.',
      '  Nothing has been published. Fix the failure and re-run `pnpm deploy`.',
      '  This ran inside the deploy on purpose — a gate that depends on an operator typing',
      '  `&&` rather than `;` is not a gate.',
    ].join('\n'),
  );
  process.exit(1);
}
console.log('─────────────────── verification passed ───────────────────\n');

await assertHeadroomOrRefuse(target.apiOrigin);
appendFileSync(COST_FILE, '1\n'); // the headroom probe is itself a request — count it

/**
 * Brief 40 §C — READ THE RETENTION RULE BACK FROM THE LIVE BUCKET.
 *
 * Finding 7 was that nothing in this repository established a lock existed on production:
 * retention lived in a D1 column and in customer-facing documents, and neither can prevent a
 * deletion. Provisioning a rule once by hand would be the same finding in a new costume, which
 * is why §B and §C ship together — the rule is asserted against the live configuration on every
 * deploy, or the product does not get to claim it.
 *
 * Fails CLOSED, in the same posture as the currency gate: absent, mis-scoped, disabled,
 * shortened, or indefinite each stop the deploy and name what is wrong. This runs BEFORE
 * anything is built or published, because the claim is about the bucket, not about this build.
 *
 * The read is a control-plane call and does not spend the Workers request budget.
 */
function assertVaultRetentionOrRefuse() {
  let text;
  try {
    text = readVaultLock(VAULT_BUCKET, path.join(ROOT, 'workers/api'));
  } catch (error) {
    console.error(
      [
        '',
        `✗ DEPLOY REFUSED: could not read the retention rule on '${VAULT_BUCKET}'.`,
        `  ${String(error).split('\n')[0]}`,
        '  Retention that cannot be read back is not retention (Brief 40 §C).',
      ].join('\n'),
    );
    process.exit(1);
  }
  const verdict = assertVaultLock(parseLockRules(text));
  if (!verdict.ok) {
    console.error(
      [
        '',
        `✗ DEPLOY REFUSED: the vault retention rule on '${VAULT_BUCKET}' does not match the claim.`,
        ...verdict.problems.map((p) => `    · ${p}`),
        '',
        '  Sealed evidence is described to users and to counsel as retained for 36 months.',
        '  Provision or correct the rule, then re-run `pnpm deploy`:',
        `    ${provisionCommand(VAULT_BUCKET)}`,
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `    vault retention: '${verdict.rule.name}' over '${verdict.rule.prefix}' — ${verdict.rule.condition} ✓`,
  );
}

assertVaultRetentionOrRefuse();

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

// §F — name the number, and name a TRUE one. The first run of this line reported zero while the
// currency table above it showed two successful polls, because the polling happens in a child
// process with its own module instance. The tally is now a file every process appends to.
const spent = readFileSync(COST_FILE, 'utf8').split('\n').filter(Boolean).length;
try {
  unlinkSync(COST_FILE);
} catch {
  /* the tally is already read; a leftover temp file is not worth failing a deploy over */
}
console.log(`\n[gate] this deploy's gates issued ${spent} request(s) against the plan limit.`);
