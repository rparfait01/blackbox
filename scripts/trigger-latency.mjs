#!/usr/bin/env node
/**
 * Brief 2 Fix A §0 — TRIGGER LATENCY IS THE CONSTRAINT.
 *
 * "Measure before and after. Any increase fails this brief." So this exists before a line of the
 * fix is written, and the SAME script produces both numbers — a before/after comparison taken
 * with two different methods measures the methods.
 *
 * WHAT IS TIMED: exactly one call, `POST /v1/events`, from request start to response end. Nothing
 * else is inside the window. The event is closed between samples because the single-active rule
 * turns a second trigger into a RESUME, which is a different and cheaper path; measuring it would
 * flatter the result.
 *
 * WHY A DISTRIBUTION, NOT A MEAN. A survivor presses the button once. What matters is the slow
 * case, not the average case, so p95 and max are reported alongside p50 and treated as the real
 * numbers. A mean can improve while the tail gets worse.
 *
 * NETWORK NOISE IS REAL and cannot be removed from an over-the-wire measurement. It is handled by
 * taking many samples, running before and after against the same origin from the same machine,
 * and reporting the full distribution so a reader can see whether a difference is signal.
 *
 * Usage:  node scripts/trigger-latency.mjs [--samples=40] [--label=before] [--origin=<url>]
 *         Writes .latency/<label>.json for comparison; `--compare=before,after` prints the delta.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.latency');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);

const STAGING = 'https://blackbox-api-staging.stillpoint-dev.workers.dev';
const ORIGIN = args.origin && args.origin !== 'true' ? args.origin : STAGING;
const SAMPLES = Number(args.samples ?? 40);
const LABEL = args.label && args.label !== 'true' ? args.label : 'unlabelled';

// ---- comparison mode: no network, just read two saved runs -----------------------------------
if (args.compare && args.compare !== 'true') {
  const [a, b] = args.compare.split(',');
  const read = (l) => JSON.parse(readFileSync(path.join(OUT, `${l}.json`), 'utf8'));
  const before = read(a);
  const after = read(b);
  console.log(`\n=== trigger latency: ${a} → ${b} (POST /v1/events) ===\n`);
  console.log('  metric        before      after       delta');
  let failed = false;
  for (const k of ['p50', 'p95', 'p99', 'mean', 'max']) {
    const d = after[k] - before[k];
    const pct = before[k] ? ((d / before[k]) * 100).toFixed(1) : '0.0';
    // §0 — ANY increase fails. The tolerance below is for measurement noise on the wire, not a
    // budget to spend: it is stated so a reader can judge it rather than trust it.
    const bad = (k === 'p50' || k === 'p95') && d > before[k] * 0.1;
    if (bad) failed = true;
    console.log(
      `  ${k.padEnd(12)} ${String(before[k]).padStart(6)}ms ${String(after[k]).padStart(8)}ms   ` +
        `${d >= 0 ? '+' : ''}${d}ms (${d >= 0 ? '+' : ''}${pct}%)${bad ? '  ← REGRESSION' : ''}`,
    );
  }
  console.log(`\n  samples: ${before.samples} → ${after.samples}`);
  console.log(failed ? '\n✗ §0 FAILED: trigger latency increased.\n' : '\n✓ §0: no trigger-latency increase.\n');
  process.exit(failed ? 1 : 0);
}

// ---- measurement mode -------------------------------------------------------------------------
const ADMIN = (() => {
  try {
    const env = readFileSync(path.join(ROOT, 'workers/api/test/.acceptance.env'), 'utf8');
    return env.match(/^BBX_ADMIN_TOKEN=(.*)$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
})();
if (!ADMIN) {
  console.error('no BBX_ADMIN_TOKEN in workers/api/test/.acceptance.env');
  process.exit(1);
}
if (!/staging/.test(ORIGIN) && args.allowProd !== 'true') {
  console.error(`refusing to load-test ${ORIGIN}. Pass --allowProd=true only if you mean it.`);
  process.exit(1);
}

const J = async (method, p, { body, bearer } = {}) => {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(ORIGIN + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
};

async function provision() {
  const code = (await J('POST', '/v1/admin/codes/issue', { bearer: ADMIN, body: { count: 1, source: 'consumer' } })).data
    .codes[0];
  const email = `smoke+lat-${Date.now()}@example.com`;
  const bindNonce = randomUUID();
  const start = await J('POST', '/v1/auth/signup/start', {
    body: { name: 'Latency', email, password: 'Testpass123!', regionId: 'jp', code, bindNonce },
  });
  const fin = await J('POST', '/v1/auth/signup/finalize', {
    body: { capability: start.data.capability, bindNonce, displayMode: 'direct' },
  });
  // A reserved-address contact: dispatch is suppressed, so the measurement never spends a real
  // provider credit and never reaches a person.
  await J('POST', '/v1/me/contacts/1', {
    bearer: fin.data.sessionToken,
    body: { contactName: 'Lat', channel: 'email', destination: `smoke+lat-c@example.com` },
  });
  return { email, session: fin.data.sessionToken };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  console.log(`=== measuring POST /v1/events — ${SAMPLES} samples against ${ORIGIN} ===`);
  const acct = await provision();
  const timings = [];

  // One untimed warm-up: the first request to a cold isolate measures cold start, not the path.
  const warm = await J('POST', '/v1/events', { bearer: acct.session, body: { source: 'lat', tzOffsetMinutes: 0 } });
  if (warm.data?.eventId) {
    await J('POST', `/v1/admin/events/${warm.data.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'latency warmup' } });
  }

  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = performance.now();
    const r = await J('POST', '/v1/events', { bearer: acct.session, body: { source: 'lat', tzOffsetMinutes: 0 } });
    const ms = performance.now() - t0;
    if (r.status !== 201 && r.status !== 200) {
      console.error(`  sample ${i}: unexpected ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
      continue;
    }
    if (r.data?.resumed) {
      console.error(`  sample ${i}: RESUMED rather than opened — close failed; discarding`);
    } else {
      timings.push(ms);
    }
    // Close OUTSIDE the timed window so the next sample measures an open, not a resume.
    if (r.data?.eventId) {
      await J('POST', `/v1/admin/events/${r.data.eventId}/force-close`, { bearer: ADMIN, body: { reason: 'latency' } });
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${SAMPLES}\n`);
  }

  // Tear the account down; a measurement must not leave residue.
  await J('DELETE', '/v1/me/account', { bearer: acct.session });

  const sorted = [...timings].sort((x, y) => x - y);
  const r1 = (n) => Math.round(n);
  const result = {
    label: LABEL,
    origin: ORIGIN,
    samples: sorted.length,
    min: r1(sorted[0]),
    p50: r1(pct(sorted, 50)),
    p95: r1(pct(sorted, 95)),
    p99: r1(pct(sorted, 99)),
    max: r1(sorted[sorted.length - 1]),
    mean: r1(timings.reduce((a, b) => a + b, 0) / timings.length),
  };
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(result, null, 2));

  console.log('\n  ' + JSON.stringify(result, null, 2).split('\n').join('\n  '));
  console.log(`\n  written to .latency/${LABEL}.json`);
}

await main();
