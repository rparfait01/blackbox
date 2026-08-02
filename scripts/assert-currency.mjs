/**
 * Deploy currency, CLASSIFIED (Brief 35 Fix A §B).
 *
 * WHAT WENT WRONG. The poll had one failure mode: "never proved the expected build". A 521/522
 * from an account that had exhausted its daily request budget consumed exactly the same
 * retry budget as a genuinely stale artifact, and reported as a propagation timeout. It
 * abandoned two CORRECT deploys that way, and both times a human finished the gate by hand —
 * which is the worse defect, because a gate an operator can complete is not a gate.
 *
 * Retrying was also the wrong response to the actual condition. The account was over quota;
 * every retry added load to the thing it was waiting on, the same self-sustaining shape as the
 * dashboard's fixed 3s socket retry. So quota now fails IMMEDIATELY and by name.
 *
 * FIVE OUTCOMES, and each calls for a different human response:
 *
 *   CURRENT                    the expected build is live. Pass.
 *   PROPAGATING                an OLDER build of ours is live. Wait — this is normal.
 *   UNAVAILABLE                5xx/52x/connection failure. Pause the propagation budget and
 *                              back off; the artifact may be fine and the edge is not.
 *   QUOTA_EXCEEDED             over the plan limit. Fail now, retry never, say "billing".
 *   WRONG_ARTIFACT             a build that is not ours at all. Fail now, retry never.
 *
 * PROPAGATING vs WRONG_ARTIFACT is decided with a LOCAL git call and no network: a build id
 * that is an ancestor of HEAD is a previous build of this repo and will be replaced; one that
 * is not in our history at all is somebody else's artifact and no amount of waiting fixes it.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const OUTCOME = {
  CURRENT: 'CURRENT',
  PROPAGATING: 'PROPAGATING',
  UNAVAILABLE: 'UNAVAILABLE',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  WRONG_ARTIFACT: 'WRONG_ARTIFACT',
  INFRASTRUCTURE_UNAVAILABLE: 'INFRASTRUCTURE_UNAVAILABLE',
};

/**
 * Wall-clock budget for PROPAGATING, and the reasoning for the number.
 *
 * Cloudflare Pages and Workers both propagate across colos in tens of seconds; the old 12×3s
 * = 36s ceiling was too tight and abandoned correct deploys, and 20×3s = 60s still was. Three
 * minutes is comfortably beyond observed propagation while still failing a genuinely stale
 * deploy inside a coffee break. Time spent UNAVAILABLE does not count against it — an edge
 * that is refusing to answer is not evidence that the artifact is stale.
 */
export const PROPAGATION_BUDGET_MS = 180_000;

/** Longer ceiling for UNAVAILABLE, since a recovering colo legitimately takes longer. */
export const UNAVAILABLE_BUDGET_MS = 300_000;

/** §F — a hard cap on attempts, not only on wall-clock. The gate spends real requests, and
 *  under quota pressure an unbounded poll is self-defeating. */
export const MAX_ATTEMPTS = 40;

/**
 * §F — the gate's own request cost, COUNTED ACROSS PROCESSES.
 *
 * The first real deploy under this brief reported `currency poll issued 0 request(s)` while the
 * table directly above it showed two successful polls. The count was not wrong by an off-by-one;
 * it was structurally unable to be right. `deploy.mjs` reads the counter in its own process, but
 * the polling happens inside `deploy-pages.mjs`, which it spawns as a CHILD. Two processes, two
 * module instances, two counters — the parent reported the one that never counted anything.
 *
 * That is the same defect this brief exists to close, wearing different clothes: a control that
 * reports as measuring while measuring nothing. A cost line that always says zero is worse than
 * no cost line, because zero is a number an operator will believe and act on.
 *
 * So the count goes through a file when one is named. Every process that issues a gate request
 * appends to it; whoever reports sums it. Plain, durable, and correct across `execFileSync`.
 */
const COST_FILE = process.env.BBX_GATE_COST_FILE || '';
let requestsIssued = 0;

/** Called once per request actually put on the wire. */
function countRequest() {
  requestsIssued += 1;
  if (!COST_FILE) return;
  try {
    appendFileSync(COST_FILE, '1\n');
  } catch {
    // Never let cost accounting break a deploy. An unwritable ledger is reported as a gap by
    // gateRequestCount() below, not as a failure here.
  }
}

/**
 * For gate scripts that issue their own requests outside this module — the canary, chiefly.
 * The deploy's cost line is only honest if everything that spends is counted, and the canary
 * spends about eighteen times what the poll does.
 */
export function countExternalRequest() {
  countRequest();
}

export function gateRequestCount() {
  if (!COST_FILE) return requestsIssued;
  try {
    // The file is the whole picture: this process's own requests are already in it.
    return readFileSync(COST_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return requestsIssued;
  }
}

export function resetGateRequestCount() {
  requestsIssued = 0;
  if (!COST_FILE) return;
  try {
    writeFileSync(COST_FILE, '');
  } catch {
    /* see countRequest */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential with jitter. Without jitter, parallel gates hammer a recovering colo in step. */
function backoffMs(attempt) {
  const base = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * Is this build id a commit in our own history? Local git, no network.
 *
 * NO SHELL, AND NO CARET. This previously ran `git cat-file -e <sha>^{commit}` with
 * `shell: true`. On Windows `^` is cmd.exe's escape character, so the argument arrived at git
 * as `<sha>{commit}`, git errored, and this returned false for EVERY build id. The visible
 * consequence was the opposite of what §B is for: an ordinary propagation delay — the most
 * common transient state of a deploy — classified as WRONG_ARTIFACT, which is terminal and
 * retries zero times. It stayed hidden because a deploy that is CURRENT on the first attempt
 * never reaches this branch, and ours usually are.
 *
 * `cat-file -t` needs no revision syntax at all, so there is nothing left for a shell to eat.
 */
function isOurBuild(buildId) {
  if (!buildId || !/^[0-9a-f]{7,40}$/i.test(buildId)) return false;
  try {
    const type = execFileSync('git', ['cat-file', '-t', buildId], { cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return type === 'commit';
  } catch {
    return false;
  }
}

/**
 * Classify ONE observation. Pure — takes what was seen, returns what it means. Separated from
 * the polling loop so the classification can be reasoned about (and tested) without a network.
 */
export function classify({ ok, status, body, error, field, expected }) {
  if (error || status == null) {
    return { outcome: OUTCOME.UNAVAILABLE, detail: `connection failed (${error ?? 'no response'})` };
  }
  // Quota first: it is the one condition where retrying makes things worse, so nothing else
  // may claim the observation ahead of it.
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (status === 429 || /daily request limit|quota|exceeded your plan|over.?limit/i.test(text)) {
    return { outcome: OUTCOME.QUOTA_EXCEEDED, detail: `plan limit reached (HTTP ${status})` };
  }
  if (status >= 500 || status === 408) {
    return { outcome: OUTCOME.UNAVAILABLE, detail: `HTTP ${status}` };
  }
  if (!ok) {
    return { outcome: OUTCOME.UNAVAILABLE, detail: `HTTP ${status}` };
  }
  const seen = body && typeof body === 'object' ? body[field] : undefined;
  if (seen == null) {
    return { outcome: OUTCOME.UNAVAILABLE, detail: `no '${field}' field in response` };
  }
  if (seen === expected) {
    return { outcome: OUTCOME.CURRENT, detail: `'${seen}'`, seen };
  }
  // Ours-but-older is propagation; not-ours is the wrong artifact and waiting cannot fix it.
  return isOurBuild(seen)
    ? { outcome: OUTCOME.PROPAGATING, detail: `serving an earlier build of this repo ('${seen}')`, seen }
    : { outcome: OUTCOME.WRONG_ARTIFACT, detail: `serving '${seen}', which is not a commit in this repository`, seen };
}

async function observe(url, field, expected) {
  countRequest();
  try {
    const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return classify({ ok: res.ok, status: res.status, body, field, expected });
  } catch (err) {
    return classify({ error: err.message, field, expected });
  }
}

/**
 * Poll one endpoint until it is CURRENT or a terminal classification is reached.
 *
 * Returns { outcome, detail, attempts, elapsedMs, seen }. Never throws: the caller decides what
 * a classification means for the deploy, and this only decides what was observed.
 */
export async function proveCurrent(url, field, expected, opts = {}) {
  const propagationBudget = opts.propagationBudgetMs ?? PROPAGATION_BUDGET_MS;
  const unavailableBudget = opts.unavailableBudgetMs ?? UNAVAILABLE_BUDGET_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const started = Date.now();
  let propagatingMs = 0;
  let unavailableMs = 0;
  let attempts = 0;
  let last = { outcome: OUTCOME.UNAVAILABLE, detail: 'not yet attempted' };

  for (;;) {
    const tickStart = Date.now();
    last = await observe(url, field, expected);
    attempts += 1;

    if (last.outcome === OUTCOME.CURRENT) {
      return { ...last, attempts, elapsedMs: Date.now() - started };
    }
    // Terminal on sight — retrying either makes it worse (quota) or cannot help (wrong build).
    if (last.outcome === OUTCOME.QUOTA_EXCEEDED || last.outcome === OUTCOME.WRONG_ARTIFACT) {
      return { ...last, attempts, elapsedMs: Date.now() - started };
    }
    if (attempts >= maxAttempts) {
      return {
        outcome: last.outcome === OUTCOME.UNAVAILABLE ? OUTCOME.INFRASTRUCTURE_UNAVAILABLE : last.outcome,
        detail: `${last.detail} — attempt cap (${maxAttempts}) reached`,
        attempts,
        elapsedMs: Date.now() - started,
        seen: last.seen,
      };
    }

    const wait = backoffMs(attempts);
    await sleep(wait);
    const spent = Date.now() - tickStart;
    // THE PAUSE. Time spent while the edge is UNAVAILABLE does not count against the
    // propagation budget: an edge refusing to answer is not evidence that the artifact is
    // stale, and charging it to propagation is exactly how a correct deploy was abandoned.
    if (last.outcome === OUTCOME.UNAVAILABLE) {
      unavailableMs += spent;
      if (unavailableMs >= unavailableBudget) {
        return {
          outcome: OUTCOME.INFRASTRUCTURE_UNAVAILABLE,
          detail: `${last.detail} — unreachable for ${Math.round(unavailableMs / 1000)}s`,
          attempts,
          elapsedMs: Date.now() - started,
        };
      }
    } else {
      propagatingMs += spent;
      if (propagatingMs >= propagationBudget) {
        return {
          outcome: OUTCOME.PROPAGATING,
          detail: `${last.detail} — never reached '${expected}' within ${Math.round(propagationBudget / 1000)}s`,
          attempts,
          elapsedMs: Date.now() - started,
          seen: last.seen,
        };
      }
    }
  }
}

/** Prove BOTH halves and print the currency table with classifications. */
export async function checkDeployCurrency({ expected, prodUrl, workerUrl, ...opts }) {
  const pwa = await proveCurrent(`${prodUrl}/version.json`, 'build', expected, opts);
  const worker = await proveCurrent(`${workerUrl}/version`, 'version', expected, opts);
  console.log('\n──────────── deploy currency ────────────');
  console.log(`expected build : ${expected}`);
  console.log(`PWA  live      : ${pwa.outcome} — ${pwa.detail} (${pwa.attempts} attempts, ${Math.round(pwa.elapsedMs / 1000)}s)`);
  console.log(`Worker live    : ${worker.outcome} — ${worker.detail} (${worker.attempts} attempts, ${Math.round(worker.elapsedMs / 1000)}s)`);
  console.log('─────────────────────────────────────────');
  return { ok: pwa.outcome === OUTCOME.CURRENT && worker.outcome === OUTCOME.CURRENT, pwa, worker };
}

/** §D — what to tell an operator, per classification. Recovery is RESUMPTION: the publish has
 *  already happened, so re-running the gate is cheap and idempotent. No flag skips it. */
export function operatorGuidance(outcome) {
  switch (outcome) {
    case OUTCOME.QUOTA_EXCEEDED:
      return 'This is BILLING, not infrastructure. The account is over its plan request limit; retrying adds load to the condition. Raise the plan or wait for the daily reset, then re-run: pnpm deploy';
    case OUTCOME.WRONG_ARTIFACT:
      return 'The live build is not a commit in this repository. Do NOT re-run blindly — find out what published it first.';
    case OUTCOME.INFRASTRUCTURE_UNAVAILABLE:
      return 'The edge did not answer within its ceiling. The artifact is probably fine and unpublished work is not at risk. Re-run when it recovers: pnpm deploy';
    case OUTCOME.PROPAGATING:
      return 'An earlier build of this repo is still being served. Re-run to continue verifying: pnpm deploy';
    default:
      return 'Re-run: pnpm deploy';
  }
}

/**
 * §E — record the outcome, and alert at error level on the two conditions that mean something
 * systemic rather than transient.
 */
export function recordGateOutcome(label, result) {
  const line = {
    gate: label,
    outcome: result.outcome,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
    detail: result.detail,
  };
  const alerting = result.outcome === OUTCOME.QUOTA_EXCEEDED || result.outcome === OUTCOME.INFRASTRUCTURE_UNAVAILABLE;
  console.log(JSON.stringify({ level: alerting ? 'error' : 'info', alert: alerting ? 'deploy_gate_failed' : undefined, ...line }));
}

/** Deploy-time orchestrator: verify both halves, or exit non-zero naming the classification. */
export async function assertDeployCurrencyOrExit(opts) {
  const { ok, pwa, worker } = await checkDeployCurrency(opts);
  recordGateOutcome('pwa', pwa);
  recordGateOutcome('worker', worker);
  if (!ok) {
    for (const [half, r] of [
      ['PWA', pwa],
      ['Worker', worker],
    ]) {
      if (r.outcome !== OUTCOME.CURRENT) {
        console.error(`\n✗ ${half} — ${r.outcome}: ${r.detail}`);
        console.error(`  ${operatorGuidance(r.outcome)}`);
      }
    }
    console.error('\nFailing loud — neither half is trusted until both verify against the live endpoints.');
    process.exit(1);
  }
  console.log('\n✓ production PWA and Worker both match the committed build.');
}
