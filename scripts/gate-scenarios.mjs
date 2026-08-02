#!/usr/bin/env node
/**
 * Brief 35 Fix A — THE GATE'S FAILURE MODES, PROVEN AGAINST A LOCAL STUB.
 *
 * WHY LOCAL. Acceptance 3–7 and 10 are all failure paths: a stale colo, a 522, a sustained 522,
 * a quota signal, a foreign artifact, an exhausted plan limit. Every one of them is a condition
 * production is not in and cannot be asked to enter. The previous way to "prove" them was to
 * reason about the code and assert the reasoning in prose — which is exactly how the poll came
 * to treat a billing cutoff as a propagation timeout for two deploys running.
 *
 * So this stands up an HTTP server on loopback, scripts the exact sequence of responses each
 * scenario needs, and drives the REAL `proveCurrent` against it. Not `classify()` in isolation —
 * the whole loop, including the backoff, the budget accounting and the terminal decisions. The
 * stub counts the requests it receives, so "zero retries" is a measurement rather than a claim.
 *
 * COST AGAINST PRODUCTION: ZERO. Nothing here touches Cloudflare.
 *
 * Usage:  node scripts/gate-scenarios.mjs
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

import { OUTCOME, proveCurrent, operatorGuidance } from './assert-currency.mjs';
import { HEADROOM, headroomVerdict } from './headroom.mjs';

let failures = 0;
const results = [];

function check(id, name, cond, detail = '') {
  if (!cond) failures += 1;
  results.push({ id, name, pass: cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}${detail ? `  [${detail}]` : ''}`);
}

/**
 * A stub that plays a scripted list of responses, then repeats the last one forever.
 * Counts every request it serves — that count is how "no retry" is proven.
 */
async function withStub(script, fn) {
  let served = 0;
  const server = createServer((req, res) => {
    const step = script[Math.min(served, script.length - 1)];
    served += 1;
    if (step.hangup) {
      req.socket.destroy();
      return;
    }
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/version`;
  try {
    return await fn(url, () => served);
  } finally {
    server.close();
  }
}

// A real earlier commit in this repository — so `isOurBuild` resolves it as ours and the
// classification is PROPAGATING rather than WRONG_ARTIFACT. Taken from live git, not hardcoded,
// because a hardcoded sha silently stops being real after a rebase.
const OLDER = execFileSync('git', ['rev-parse', '--short', 'HEAD~1'], { shell: true }).toString().trim();
const EXPECTED = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { shell: true }).toString().trim();

// Budgets small enough to run in seconds. The BEHAVIOUR under test is the shape of the loop —
// which condition is terminal, which pauses which budget — and that is independent of the
// production numbers, which are asserted separately in the guard test.
const FAST = { propagationBudgetMs: 4_000, unavailableBudgetMs: 4_000, maxAttempts: 12 };

console.log('\n=== Brief 35 Fix A — gate failure modes (local stub, zero production cost) ===\n');

// ---- ACCEPTANCE 3 — stale colo resolves ---------------------------------------------------
console.log('A3 — stale colo → PROPAGATING → resolves → passes');
await withStub(
  [
    { status: 200, body: { version: OLDER } },
    { status: 200, body: { version: OLDER } },
    { status: 200, body: { version: EXPECTED } },
  ],
  async (url, served) => {
    // The budget must exceed a couple of backoffs (4s, then 8s) or the scenario times out on
    // its own sizing rather than on the behaviour under test.
    const r = await proveCurrent(url, 'version', EXPECTED, { ...FAST, propagationBudgetMs: 30_000 });
    check('A3', 'ends CURRENT after serving an older build of ours', r.outcome === OUTCOME.CURRENT, r.detail);
    check('A3', 'it RETRIED rather than failing on the first stale read', served() >= 3, `${served()} requests`);
  },
);

// ---- ACCEPTANCE 4 — the scenario that abandoned two correct deploys ------------------------
console.log('\nA4 — 522 → UNAVAILABLE, budget PAUSES, passes on recovery');
await withStub(
  [
    { status: 522, body: '' },
    { status: 522, body: '' },
    { status: 522, body: '' },
    { status: 200, body: { version: EXPECTED } },
  ],
  async (url, served) => {
    // THE PROOF OF THE PAUSE. The propagation budget is set to 1ms — smaller than a single
    // backoff. If 522 time were charged to propagation (the old behaviour), this MUST return
    // PROPAGATING on the first retry. Reaching CURRENT is only possible if the pause is real.
    const r = await proveCurrent(url, 'version', EXPECTED, {
      propagationBudgetMs: 1,
      unavailableBudgetMs: 60_000,
      maxAttempts: 12,
    });
    check('A4', 'recovers to CURRENT after a run of 522s', r.outcome === OUTCOME.CURRENT, r.detail);
    check(
      'A4',
      'the propagation budget was NOT consumed by unavailability (1ms budget survived)',
      r.outcome === OUTCOME.CURRENT,
      `${served()} requests, ${r.attempts} attempts`,
    );
  },
);

// ---- ACCEPTANCE 5 — sustained unavailability ----------------------------------------------
console.log('\nA5 — sustained 522 past the ceiling → INFRASTRUCTURE_UNAVAILABLE');
await withStub([{ status: 522, body: '' }], async (url) => {
  const r = await proveCurrent(url, 'version', EXPECTED, FAST);
  check('A5', 'classifies INFRASTRUCTURE_UNAVAILABLE, not stale', r.outcome === OUTCOME.INFRASTRUCTURE_UNAVAILABLE, r.detail);
  const g = operatorGuidance(r.outcome);
  check('A5', 'guidance names the re-run command', /pnpm deploy/.test(g));
});

// ---- ACCEPTANCE 6 — quota, zero retries ---------------------------------------------------
console.log('\nA6 — quota signal → QUOTA_EXCEEDED, ZERO retries, names billing');
for (const [label, step] of [
  ['HTTP 429', { status: 429, body: '' }],
  ['HTML cap page', { status: 403, body: 'Daily request limit exceeded' }],
]) {
  await withStub([step], async (url, served) => {
    const r = await proveCurrent(url, 'version', EXPECTED, FAST);
    check('A6', `${label} → QUOTA_EXCEEDED`, r.outcome === OUTCOME.QUOTA_EXCEEDED, r.detail);
    check('A6', `${label} → exactly ONE request issued (no retry)`, served() === 1, `${served()} request(s)`);
  });
}
check('A6', 'guidance names billing, not infrastructure', /BILLING/.test(operatorGuidance(OUTCOME.QUOTA_EXCEEDED)));

// ---- ACCEPTANCE 7 — foreign artifact ------------------------------------------------------
console.log('\nA7 — foreign build id → WRONG_ARTIFACT, immediate, no retry');
await withStub([{ status: 200, body: { version: 'ffffffe' } }], async (url, served) => {
  const r = await proveCurrent(url, 'version', EXPECTED, FAST);
  check('A7', 'classifies WRONG_ARTIFACT', r.outcome === OUTCOME.WRONG_ARTIFACT, r.detail);
  check('A7', 'exactly ONE request issued (waiting cannot fix it)', served() === 1, `${served()} request(s)`);
});

// ---- ACCEPTANCE 10 — headroom refusal ------------------------------------------------------
console.log('\nA10 — headroom below threshold → deploy refuses to start');
{
  const refuse = headroomVerdict({ configured: true, usedFraction: 0.95, summary: '95k/100k' });
  check('A10', 'at 95% of the limit the verdict is REFUSE', refuse.state === HEADROOM.REFUSE);
  check('A10', 'the refusal names BILLING and says nothing was published', /BILLING/.test(refuse.message) && /nothing has been published/.test(refuse.message));
  const ok = headroomVerdict({ configured: true, usedFraction: 0.5, summary: '50k/100k' });
  check('A10', 'at 50% the deploy proceeds', ok.state === HEADROOM.OK);
  const unmeasured = headroomVerdict({ configured: false });
  check('A10', 'unconfigured reports NOT MEASURED and is never reported as room', unmeasured.state === HEADROOM.NOT_MEASURED && /NOT MEASURED/.test(unmeasured.message));
  // The boundary is asserted explicitly: 0.9 refuses, so the threshold is inclusive.
  check('A10', 'the threshold is inclusive at exactly 90%', headroomVerdict({ configured: true, usedFraction: 0.9, summary: '' }).state === HEADROOM.REFUSE);
}

console.log(
  failures === 0
    ? `\n✓ all ${results.length} scenario checks passed — 0 requests spent against production\n`
    : `\n✗ ${failures} of ${results.length} scenario checks FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
