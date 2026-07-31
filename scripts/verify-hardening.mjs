#!/usr/bin/env node
/**
 * Deploy-hardening proof — the failure paths of the deploy gates, exercised without a
 * destructive production deploy. Exits non-zero if any check fails, so it can gate the
 * fix like the acceptance suite gates the app.
 *
 * Brief 0 (currency):
 *   1. A forced worker mismatch is caught (never claims current).
 *   2. An unreachable /version FAILS CLOSED (not 'unknown', not skipped).
 *   plus the happy path (both halves prove current).
 *
 * Brief 35 §A (origin): every way a build can end up with no alert path is REFUSED —
 * absent, empty, http://, a private host, a loopback address, a reserved TLD. These are
 * the same rules the vite build gate and the deploy script call, so proving them here
 * proves them everywhere; they are asserted in isolation because the alternative is
 * running `pnpm deploy` with a deliberately broken config to watch it fail.
 */
import { proveCurrent, checkDeployCurrency } from './assert-currency.mjs';
import { validateApiOrigin, deployTarget } from './api-origin.mjs';

const PROD_URL = 'https://blackbox-pwa.pages.dev';
const WORKER_URL = 'https://blackbox-api.stillpoint-dev.workers.dev';
const UNREACHABLE = 'https://blackbox-api.invalid.example.test/version';
const FAST = { tries: 2, delayMs: 500 };

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`);
  if (!cond) failures += 1;
};

// ---- Brief 35 §A — the origin rules -------------------------------------------------
// Every value below produced a SHIPPABLE build before this brief: the PWA compiled, the
// deploy went green, and the alert path did not exist.
for (const [label, value] of [
  ['absent (undefined)', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['http:// (not https)', 'http://blackbox-api.stillpoint-dev.workers.dev'],
  ['localhost', 'https://localhost:8787'],
  ['loopback 127.0.0.1', 'https://127.0.0.1:8787'],
  ['private 192.168.x', 'https://192.168.1.50'],
  ['private 10.x', 'https://10.0.0.4'],
  ['private 172.16.x', 'https://172.20.0.9'],
  ['link-local 169.254.x', 'https://169.254.1.1'],
  ['reserved .test TLD', 'https://api.blackbox.test'],
  ['not a URL', 'blackbox-api.stillpoint-dev.workers.dev'],
]) {
  const r = validateApiOrigin(value);
  check(`origin REFUSED — ${label}`, r.ok === false && typeof r.reason === 'string' && r.reason.length > 0);
}

// …and the real one is accepted, normalised. A gate that refuses everything is not a gate.
const good = validateApiOrigin('https://blackbox-api.stillpoint-dev.workers.dev/');
check('origin ACCEPTED — the real production worker', good.ok === true);
check('origin is normalised (no trailing slash)', good.origin === 'https://blackbox-api.stillpoint-dev.workers.dev');

// The tracked config itself passes the rule it is read through.
const prodTarget = deployTarget('production');
check(
  `config/deploy-targets.json production.apiOrigin is valid (${prodTarget.apiOrigin})`,
  prodTarget.apiOrigin === 'https://blackbox-api.stillpoint-dev.workers.dev',
);
console.log('');

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
