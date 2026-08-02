import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OUTCOME, classify, MAX_ATTEMPTS, PROPAGATION_BUDGET_MS } from '../../../scripts/assert-currency.mjs';
import { checkDeployToolchain, checkTool, satisfies } from '../../../scripts/toolchain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Brief 35 Fix A — the gate, and the two ways it was not one.
 *
 * The currency poll abandoned a CORRECT deploy twice, and both times I finished the gate by
 * running the canary by hand. The abandonment was a classification failure: a 521/522 from an
 * account over its daily request cap consumed the same retry budget as a genuinely stale
 * artifact and reported as a propagation timeout. The manual completion was the worse half —
 * a gate an operator can finish is not a gate, and doing it twice is how it becomes habit.
 */
describe('§B five outcomes, and quota never retries', () => {
  it('an over-quota response is QUOTA_EXCEEDED, not a propagation timeout', () => {
    expect(classify({ ok: false, status: 429, body: '', field: 'version', expected: 'abc' }).outcome).toBe(
      OUTCOME.QUOTA_EXCEEDED,
    );
    // Cloudflare answers the daily cap with an HTML error page, not a tidy 429.
    expect(
      classify({ ok: false, status: 403, body: 'Daily request limit exceeded', field: 'version', expected: 'abc' }).outcome,
    ).toBe(OUTCOME.QUOTA_EXCEEDED);
  });

  it('quota is decided BEFORE 5xx can claim the observation', () => {
    // Retrying an over-quota account adds load to the condition it is waiting on — the same
    // self-sustaining shape as the dashboard's fixed 3s socket retry. If 5xx matched first,
    // the gate would back off and keep spending.
    const r = classify({ ok: false, status: 503, body: 'quota exceeded', field: 'version', expected: 'abc' });
    expect(r.outcome).toBe(OUTCOME.QUOTA_EXCEEDED);
  });

  it('52x and connection failure are UNAVAILABLE, not stale', () => {
    expect(classify({ ok: false, status: 522, body: '', field: 'version', expected: 'abc' }).outcome).toBe(OUTCOME.UNAVAILABLE);
    expect(classify({ error: 'fetch failed', field: 'version', expected: 'abc' }).outcome).toBe(OUTCOME.UNAVAILABLE);
  });

  it('a matching build is CURRENT', () => {
    expect(classify({ ok: true, status: 200, body: { version: 'abc123' }, field: 'version', expected: 'abc123' }).outcome).toBe(
      OUTCOME.CURRENT,
    );
  });

  it('an unrelated build id is WRONG_ARTIFACT and never retries', () => {
    // Decided with a LOCAL git lookup and no network: a build id that is not a commit in this
    // repository is somebody else's artifact, and no amount of waiting fixes it.
    const r = classify({ ok: true, status: 200, body: { version: 'ffffffe' }, field: 'version', expected: 'abc123' });
    expect(r.outcome).toBe(OUTCOME.WRONG_ARTIFACT);
  });

  it('the budget is a stated number with reasoning, and attempts are capped too', () => {
    // §F — wall-clock alone is not enough when each attempt costs a request against a limit
    // whose exhaustion takes the alert path down.
    expect(PROPAGATION_BUDGET_MS).toBe(180_000);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(40);
  });

  it('UNAVAILABLE pauses the propagation budget rather than spending it', () => {
    const src = read('scripts/assert-currency.mjs');
    expect(src).toMatch(/unavailableMs \+= spent;/);
    expect(src).toMatch(/propagatingMs \+= spent;/);
  });

  it('backoff is jittered', () => {
    expect(read('scripts/assert-currency.mjs')).toMatch(/0\.75 \+ Math\.random\(\) \* 0\.5/);
  });
});

describe('§C there is no manual gate-completion path', () => {
  const canary = read('scripts/canary.mjs');
  const deploy = read('scripts/deploy.mjs');

  it('the canary requires a nonce minted by THIS deploy run', () => {
    expect(canary).toMatch(/const GATE_NONCE = process\.env\.BBX_GATE_NONCE \?\? '';/);
    expect(canary).toMatch(/consumeGateMarker\(\{ nonce: GATE_NONCE/);
    expect(deploy).toMatch(/BBX_GATE_NONCE: GATE_NONCE/);
    expect(deploy).toMatch(/randomBytes\(24\)\.toString\('hex'\)/);
  });

  it('an ungated run is DIAGNOSTIC, marked, and exits non-zero', () => {
    // It still runs and is still useful. What it cannot do is be mistaken for a pass — by a
    // human reading the output or by a script reading the exit code.
    expect(canary).toMatch(/DIAGNOSTIC RUN — THIS CANNOT SATISFY THE DEPLOY GATE/);
    expect(canary).toMatch(/THIS DID NOT SATISFY THE GATE/);
    expect(canary).toMatch(/process\.exit\(2\);/);
  });

  it('nothing marks the gate satisfied except the poll', () => {
    // The success line is reachable only after the diagnostic branch has exited.
    const tail = canary.slice(canary.indexOf('if (IS_DIAGNOSTIC) {', canary.indexOf('─────────────── canary')));
    expect(tail.indexOf('process.exit(2)')).toBeLessThan(tail.indexOf('canary round trip complete'));
  });
});

describe('§C the nonce is single-use, so the gate cannot be finished by replay', () => {
  it('a length check alone is not the gate', () => {
    // The first cut accepted any 16+ character string, so `BBX_GATE_NONCE=$(openssl rand -hex 24)`
    // satisfied it — and, far more likely, so did re-running the canary with the deploy's own
    // environment still exported. That replay IS the habit this section exists to remove.
    const src = read('scripts/gate-nonce.mjs');
    expect(src).toMatch(/export function consumeGateMarker/);
    expect(src).toMatch(/unlinkSync\(markerPath\)/);
    expect(src).toMatch(/MARKER_TTL_MS/);
  });

  it('deploy.mjs mints the marker the canary consumes', () => {
    expect(read('scripts/deploy.mjs')).toMatch(/writeFileSync\(path\.join\(ROOT, '\.gate-run'\)/);
    expect(read('.gitignore')).toMatch(/\.gate-run/);
  });

  it('a diagnostic run states WHY it did not count', () => {
    expect(read('scripts/canary.mjs')).toMatch(/GATE\.reason/);
  });

  it('the marker is spent even by a WRONG guess', () => {
    // Otherwise a wrong guess could be followed by a right one against the same marker.
    const src = read('scripts/gate-nonce.mjs');
    const consumeIdx = src.indexOf('unlinkSync(markerPath)');
    const matchIdx = src.indexOf('marker.nonce !== nonce');
    expect(consumeIdx).toBeGreaterThan(0);
    expect(consumeIdx).toBeLessThan(matchIdx);
  });
});

describe('§D no flag skips or shortens the gate', () => {
  it('no bypass switch exists in the deploy path', () => {
    for (const f of ['scripts/deploy.mjs', 'scripts/deploy-pages.mjs', 'scripts/canary.mjs']) {
      const code = strip(read(f));
      expect(code, `${f} must expose no gate bypass`).not.toMatch(/SKIP_GATE|NO_CANARY|--skip|FORCE_PASS|BYPASS/i);
    }
  });

  it('failure names the re-run command — recovery is resumption, not bypass', () => {
    // The publish has already happened by the time the gate runs, so re-running is cheap and
    // idempotent. An operator who is told what to run does not go looking for a shortcut.
    const src = read('scripts/assert-currency.mjs');
    expect(src).toMatch(/export function operatorGuidance/);
    expect((src.match(/pnpm deploy/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/This is BILLING, not infrastructure/);
  });
});

describe('the poll result shape and its callers do not drift apart', () => {
  it('no caller reads a boolean `.ok` off proveCurrent', () => {
    // This is the bug I actually shipped into the working tree. proveCurrent stopped
    // returning `ok` when it started returning a classification, and canary.mjs still read
    // `if (!proven.ok)`. `!undefined` is true, so the canary would have failed EVERY deploy,
    // including correct ones — a gate that always fails is as useless as one that always
    // passes, and I would not have found it without running the thing I should not have run.
    for (const f of ['scripts/canary.mjs', 'scripts/verify-hardening.mjs']) {
      const src = read(f);
      const uses = src.match(/proveCurrent\([\s\S]{0,400}/g) ?? [];
      for (const u of uses) {
        expect(u, `${f} must classify, not read .ok`).not.toMatch(/(proven|mismatch|down)\.ok/);
      }
    }
  });

  it('every caller compares against OUTCOME rather than truthiness', () => {
    expect(read('scripts/canary.mjs')).toMatch(/proven\.outcome !== OUTCOME\.CURRENT/);
    expect(read('scripts/verify-hardening.mjs')).toMatch(/\.outcome !== OUTCOME\.CURRENT/);
  });

  it('verify-hardening passes budgets the poller actually understands', () => {
    // The old `{tries, delayMs}` were silently ignored by the new signature, so a run that
    // should have cost 4 requests spent ~45 against an exhausted plan limit.
    const src = read('scripts/verify-hardening.mjs');
    expect(src).toMatch(/maxAttempts: 2/);
    expect(src).not.toMatch(/tries: \d/);
  });
});

describe('the two defects a real deploy exposed', () => {
  it('the build-id lookup passes no shell metacharacter to a shell', () => {
    // `git cat-file -e <sha>^{commit}` with shell:true. On Windows `^` is cmd.exe's escape
    // character, so git received `<sha>{commit}`, errored, and isOurBuild returned false for
    // EVERY id — turning ordinary propagation into WRONG_ARTIFACT, which never retries. Invisible
    // until a deploy was slow to propagate, because a first-attempt CURRENT never takes the branch.
    // strip() first: the comment that EXPLAINS this bug necessarily contains the bug's text.
    const src = strip(read('scripts/assert-currency.mjs'));
    expect(src).not.toMatch(/\^\{commit\}/);
    expect(src).toMatch(/'cat-file', '-t', buildId/);
    expect(src).toMatch(/shell: false/);
  });

  it('the request tally survives the process boundary it is counted across', () => {
    // deploy.mjs read an in-memory counter while the polling happened in a spawned child, so the
    // very first deploy under this brief reported `issued 0 request(s)` beneath a table showing
    // two successful polls. A cost line that always reads zero is worse than none.
    const currency = read('scripts/assert-currency.mjs');
    expect(currency).toMatch(/BBX_GATE_COST_FILE/);
    expect(currency).toMatch(/appendFileSync\(COST_FILE/);
    const deploy = read('scripts/deploy.mjs');
    expect(deploy).toMatch(/BBX_GATE_COST_FILE: COST_FILE/);
    // and the report reads the ledger, not a local variable
    expect(deploy).toMatch(/readFileSync\(COST_FILE, 'utf8'\)/);
    expect(deploy).not.toMatch(/the canary issues ~18/);
  });

  it('the canary counts the requests it issues into the same ledger', () => {
    const canary = strip(read('scripts/canary.mjs'));
    expect((canary.match(/countExternalRequest\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('§A the toolchain that performs a deploy is the one this repo pins', () => {
  it('wrangler is pinned to 4.x in every workspace that deploys', () => {
    for (const f of ['workers/api/package.json', 'apps/pwa/package.json']) {
      expect(JSON.parse(read(f)).devDependencies.wrangler, f).toMatch(/^\^4\./);
    }
  });

  it('no deploy step runs wrangler from a directory that has not installed it', () => {
    // deploy-pages.mjs ran `npx wrangler` with cwd:ROOT, and the root has no wrangler in
    // node_modules — so npx fetched one from the REGISTRY. The client half of every deploy was
    // published by 4.99.0 off the network while package.json pinned 4.118.0: not reproducible,
    // not reviewable, and a toolchain download in the middle of a production deploy.
    const src = read('scripts/deploy-pages.mjs');
    expect(src).toMatch(/cwd: path\.join\(ROOT, 'apps\/pwa'\)/);
    // The wrangler INVOCATION passes a relative 'dist'; the DIST constant above it is a
    // legitimate absolute path used to read the build output, so match the args, not the file.
    expect(src).toMatch(/'pages', 'deploy', 'dist'/);
  });

  it('the production worker deploy names its environment explicitly', () => {
    // With [env.staging] defined, a bare `wrangler deploy` is ambiguous and wrangler 4 warns it
    // risks changing the wrong environment. The other environment here is the one the
    // write-heavy acceptance suite targets, so the ambiguity is worth removing outright.
    expect(read('scripts/deploy-worker.mjs')).toMatch(/'--env=""'/);
  });

  it('telemetry stays off — it is a stated principle, not a default', () => {
    expect(read('workers/api/wrangler.toml')).toMatch(/send_metrics = false/);
  });
});

describe('RATIFIED — a declared version is not an installed version', () => {
  it('every tool the deploy invokes is installed where it is invoked from', () => {
    for (const r of checkDeployToolchain(ROOT)) {
      expect(r.ok, r.problem ?? '').toBe(true);
      expect(r.installed).toBeTruthy();
    }
  });

  it('an undeclared tool is a REFUSAL, because npx would fetch it from the registry', () => {
    const r = checkTool(ROOT, '.', 'wrangler');
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/resolves from the REGISTRY/);
  });

  it('a version outside the declared range is a refusal', () => {
    expect(satisfies('4.118.0', '^4.42.0')).toBe(true);
    expect(satisfies('3.114.17', '^4.42.0')).toBe(false);
    expect(satisfies('4.41.0', '^4.42.0')).toBe(false);
  });

  it('an unparseable range THROWS rather than passing', () => {
    // "I could not evaluate the constraint" and "the constraint is met" are different answers,
    // and only one of them is safe to act on.
    expect(() => satisfies('4.1.0', '>=4 <5')).toThrow();
  });

  it('the gate reports the toolchain and refuses a mismatch', () => {
    const deploy = read('scripts/deploy.mjs');
    expect(deploy).toMatch(/toolchain: \$\{r\.dir\} \$\{r\.tool\}@/);
    expect(deploy).toMatch(/DEPLOY REFUSED: the toolchain that would run/);
  });
});

describe('§E/§F the gate records itself and knows its own cost', () => {
  it('every outcome is recorded with classification, attempts and elapsed', () => {
    const src = read('scripts/assert-currency.mjs');
    expect(src).toMatch(/export function recordGateOutcome/);
    expect(src).toMatch(/attempts: result\.attempts/);
    expect(src).toMatch(/elapsedMs: result\.elapsedMs/);
  });

  it('quota and sustained unavailability alert at error level', () => {
    expect(read('scripts/assert-currency.mjs')).toMatch(/level: alerting \? 'error' : 'info'/);
  });

  it('the deploy refuses to start when headroom is gone', () => {
    // Discovering mid-deploy that there was no budget for the verification is how a correct
    // deploy gets abandoned and finished by hand.
    expect(read('scripts/headroom.mjs')).toMatch(/DEPLOY REFUSED: request headroom is/);
    expect(read('scripts/headroom.mjs')).toMatch(/HEADROOM_REFUSE_ABOVE = 0\.9/);
    expect(read('scripts/deploy.mjs')).toMatch(/verdict\.state === HEADROOM\.REFUSE/);
  });

  it('the gate reports its own request cost, from the shared ledger', () => {
    expect(read('scripts/deploy.mjs')).toMatch(/issued \$\{spent\} request\(s\) against the plan limit/);
  });

  it('the headroom decision is testable without performing a deploy', () => {
    // It used to live inside deploy.mjs, which does its work at import time — so the refusal path
    // could only be exercised by actually deploying. A refusal that can only be tested
    // destructively does not get tested.
    const src = read('scripts/headroom.mjs');
    expect(src).toMatch(/export function headroomVerdict/);
    expect(src).toMatch(/HEADROOM_REFUSE_ABOVE = 0\.9/);
    expect(read('scripts/deploy.mjs')).toMatch(/from '\.\/headroom\.mjs'/);
  });
});
