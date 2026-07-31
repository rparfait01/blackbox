/**
 * Brief 0 — deploy currency assertion, hardened on BOTH halves.
 *
 * Proves that the LIVE deployed PWA and the LIVE deployed Worker each report the
 * expected build hash, reading the live endpoints (cache-busted) — never a local
 * build artifact. It FAILS CLOSED: a stale, erroring, unreachable, or unparseable
 * endpoint is a FAILURE, never 'unknown' and never a skip. No success is claimed
 * unless both halves verify. Verification always precedes the success message.
 *
 * Factored out of deploy-pages.mjs so the failure paths are provable in isolation
 * (scripts/verify-hardening.mjs) without a destructive production deploy. Deploy
 * tooling only — no application code.
 */

async function liveJson(url) {
  // Cache-bust + no-store so we read what the edge is serving RIGHT NOW, never a
  // cached or local copy.
  const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Poll a live endpoint until `field` === `expected`, or give up after `tries`.
 * Returns { ok, seen }. `ok` is true ONLY when the live endpoint proved the
 * expected build. Anything else — mismatch, missing field, unreachable, error —
 * returns ok:false with a human-readable `seen`. It never returns 'unknown'.
 */
/**
 * `tries` was 12 (≈36s), and Cloudflare Pages routinely takes longer than that to serve a
 * fresh deploy from every edge. That produced a FALSE deploy failure — the artifact was
 * published and correct, both halves reported the new build twenty seconds later, and the
 * gate had already aborted and skipped the canary.
 *
 * Waiting longer does not weaken the gate: it still fails CLOSED if the build never
 * propagates, which is the failure it exists to catch. What it removes is the other kind of
 * dishonesty — a gate that cries wolf trains an operator to rerun it without reading it.
 */
export async function proveCurrent(url, field, expected, { tries = 20, delayMs = 3000 } = {}) {
  let seen = 'unreachable';
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = (await liveJson(url))[field];
      seen = value == null ? 'missing build field' : `'${value}'`;
      if (value === expected) return { ok: true, seen };
    } catch (err) {
      seen = `unreachable (${err.message})`;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, seen };
}

/**
 * Prove BOTH halves current against their live endpoints and print the currency
 * table. Returns { ok, pwa, worker } and does NOT exit — so it is unit-testable.
 */
export async function checkDeployCurrency({ expected, prodUrl, workerUrl, tries, delayMs }) {
  const opts = { tries, delayMs };
  const pwa = await proveCurrent(`${prodUrl}/version.json`, 'build', expected, opts);
  const worker = await proveCurrent(`${workerUrl}/version`, 'version', expected, opts);
  console.log('\n──────────── deploy currency ────────────');
  console.log(`expected build : ${expected}`);
  console.log(`PWA  live      : ${pwa.ok ? `'${expected}'` : pwa.seen}`);
  console.log(`Worker live    : ${worker.ok ? `'${expected}'` : worker.seen}`);
  console.log('─────────────────────────────────────────');
  return { ok: pwa.ok && worker.ok, pwa, worker };
}

/**
 * Deploy-time orchestrator: verify both halves, then exit non-zero if either is
 * not proven current. The success line prints ONLY after both verify.
 */
export async function assertDeployCurrencyOrExit(opts) {
  const { ok, pwa, worker } = await checkDeployCurrency(opts);
  if (!ok) {
    if (!pwa.ok) {
      console.error(`\n✗ PWA CURRENCY FAILED: production PWA never proved '${opts.expected}' (last seen: ${pwa.seen}).`);
      console.error('  The deploy did NOT reach production (stale cache or wrong target).');
    }
    if (!worker.ok) {
      console.error(`\n✗ WORKER CURRENCY FAILED: worker never proved '${opts.expected}' (last seen: ${worker.seen}).`);
      console.error('  A stale, erroring, or unreachable worker fails CLOSED — production may be SPLIT. Redeploy the worker.');
    }
    console.error('\nFailing loud — neither half is trusted until both verify against the live endpoints.');
    process.exit(1);
  }
  console.log('\n✓ production PWA and Worker both match the committed build.');
}
