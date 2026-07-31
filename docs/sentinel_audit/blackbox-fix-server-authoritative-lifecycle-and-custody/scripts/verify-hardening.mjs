#!/usr/bin/env node
/**
 * Brief 0 proof — the deploy-currency hardening, exercised against the LIVE
 * endpoints without a destructive production deploy. Proves the two defects are
 * closed:
 *   1. A forced worker mismatch is caught (never claims current).
 *   2. An unreachable /version FAILS CLOSED (not 'unknown', not skipped).
 * plus the happy path (both halves prove current). Exits non-zero if any check
 * fails, so it can gate the fix like the acceptance suite gates the app.
 */
import { proveCurrent, checkDeployCurrency } from './assert-currency.mjs';

const PROD_URL = 'https://blackbox-pwa.pages.dev';
const WORKER_URL = 'https://blackbox-api.stillpoint-dev.workers.dev';
const UNREACHABLE = 'https://blackbox-api.invalid.example.test/version';
const FAST = { tries: 2, delayMs: 500 };

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`);
  if (!cond) failures += 1;
};

// The build the live worker actually reports right now — so the happy path is
// asserted against real current state, not a guess.
const realBuild = (await (await fetch(`${WORKER_URL}/version?ts=${Date.now()}`, { cache: 'no-store' })).json()).version;
console.log(`(live worker currently reports build '${realBuild}')\n`);

// Defect 1 — a forced mismatch must be caught, never reported current.
const mismatch = await proveCurrent(`${WORKER_URL}/version`, 'version', 'deadbeef-not-a-real-build', FAST);
check('forced worker mismatch is caught (ok:false)', mismatch.ok === false);

// Defect 2 — an unreachable endpoint must FAIL CLOSED, not degrade to 'unknown'.
const down = await proveCurrent(UNREACHABLE, 'version', realBuild, FAST);
check('unreachable worker fails closed (ok:false)', down.ok === false);
check('unreachable is a failure, never the old "unknown" skip', !/unknown/i.test(down.seen));

// Happy path — both halves prove current against the live endpoints.
const happy = await checkDeployCurrency({ expected: realBuild, prodUrl: PROD_URL, workerUrl: WORKER_URL, ...FAST });
check('happy path: both halves prove current', happy.ok === true);

console.log(failures === 0 ? '\n✓ deploy hardening proven (both defects closed)' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
