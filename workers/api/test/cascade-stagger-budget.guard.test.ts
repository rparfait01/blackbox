import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { STAGGER_BUDGET_MS } from '../src/lib/notify';

/**
 * Brief 36 §11 — the cascade "flake" was not flakiness.
 *
 * Acceptance check 8 failed at random with "expected 5 email dispatch records, got 4",
 * and it was tolerated as harness jitter across several briefs. It was not jitter. A
 * staging trace of a single event showed what was actually happening:
 *
 *   T+30.0s  cascade_fired step=3 via=stagger
 *   T+40.1s  cascade_fired step=4 via=alarm
 *   T+40.2s  all_channels_failed          <- step 4's dispatch
 *   T+40.2s  cascade_step_undelivered step=4
 *   T+40.7s  all_channels_failed          <- step 3's dispatch, ~10s late
 *            (no cascade_step_undelivered step=3 — it never landed)
 *
 * `notifyActivation` runs inside the activation request's waitUntil and used to sleep
 * all the way to T+40s. The runtime reclaims that context at roughly 30s, so the last
 * steps executed on borrowed time and were TRUNCATED MID-SEQUENCE — the dispatch landed,
 * the audit row that follows it did not. Sometimes the cut fell earlier and `cascade_fired`
 * itself was lost, which is the "got 4" the suite kept seeing.
 *
 * WHY IT MATTERED, precisely. Nobody went unnotified: every dispatch and every
 * delivery_record landed, so this was never a life-safety P0. But the audit trail IS the
 * evidence in this product — the closure report and the coordinator view are built from
 * these rows — so a cascade that silently stops recording itself is a custody defect.
 *
 * The fix is not a longer budget. It is not doing late work in a context that is about to
 * die: the in-request chain now covers only steps due within STAGGER_BUDGET_MS and hands
 * the tail to the Durable Object alarm, which fires at the exact window and does not
 * inherit the request's lifetime. Measured after the change, over 5 consecutive staging
 * runs: drivers `stagger,stagger,stagger,alarm,alarm`, and `cascade_step_undelivered`
 * rows back to 5 of 5 (previously 4 of 5 on every single run).
 */
describe('the in-request stagger stops before its context is reclaimed', () => {
  const notify = readFileSync(new URL('../src/lib/notify.ts', import.meta.url), 'utf8');

  it('the budget is a stated number, comfortably inside the ~30s waitUntil reclaim', () => {
    expect(STAGGER_BUDGET_MS).toBe(20_000);
    // Headroom is the whole point: the step must dispatch AND write its audit rows
    // before the context goes. A budget at or past ~30s reintroduces the defect.
    expect(STAGGER_BUDGET_MS).toBeLessThanOrEqual(25_000);
  });

  it('the cutoff is measured from EVENT CREATION, not from the remaining wait', () => {
    // The first attempt at this fix compared `createdAt + step*interval - now`, which
    // shrinks as the loop advances: with a 10s interval every step looked 10s away and
    // the chain still walked off the end one step at a time. Verified on staging — the
    // drivers stayed `stagger,stagger,stagger,stagger,alarm`, unchanged. The absolute
    // form is what actually moves the tail onto the alarm.
    expect(notify).toMatch(/if \(step \* interval > STAGGER_BUDGET_MS\)/);
    expect(notify).not.toMatch(/createdAt \+ step \* interval - Date\.now\(\) > STAGGER_BUDGET_MS/);
  });

  /**
   * THE WHOLE-CODEBASE AUDIT this defect triggered. Every chain that can span more than
   * the ~20s budget was examined, and the test applied to each was NOT "is it long?" but:
   *
   *     if this chain is cut halfway, does anything recover what was lost?
   *
   * That is what separates a truncation DEFECT from a design that merely ends early.
   *
   *   notifyActivation (lib/notify.ts) — up to T+40s inside a request waitUntil.
   *     Truncation is UNRECOVERABLE: advanceStep has already claimed the step, so no
   *     driver re-fires it and the audit row is lost permanently. DEFECT — fixed above.
   *
   *   audioStream / locationStream (routes/contact-streams.ts) — ~60s (60 × 1s) inside a
   *     request waitUntil, and therefore the longest chain in the worker. NOT a defect:
   *     truncation is fully recoverable by design. EventSource reconnects on its own, and
   *     the dashboard's 3s /state poll is the stated correctness guarantee with SSE only a
   *     latency enhancement — so a cut stream loses nothing that the poll does not carry.
   *     Deliberately left alone; "long" was never the problem.
   *
   *   scheduled (scheduled.ts) — eight jobs sequentially in one cron waitUntil. Each was
   *     already try/caught, so a THROW could not starve the rest, but a HANG could, and
   *     silently: an unresolved D1 call in the first job would take the integrity scan and
   *     the canary TTL sweep with it every minute, recording nothing. Same family, other
   *     route. Bounded per job.
   *
   *   Everything else (broadcastEventChange, dispatch, pruneChallenges, confirmation SMS,
   *     guardian invites) is a single sub-second await with no sleep in it.
   */
  it('the audit holds: no unbounded multi-step chain is left inside a request waitUntil', () => {
    const scheduled = readFileSync(new URL('../src/scheduled.ts', import.meta.url), 'utf8');
    // Every cron job runs under a ceiling, so one hang cannot starve the rest.
    expect(scheduled).toMatch(/async function boundedJob/);
    expect(scheduled).toMatch(/JOB_TIMEOUT_MS/);
    const chain = scheduled.slice(scheduled.indexOf('ctx.waitUntil('));
    // EVERY job, not most of them. The count moves when a job is added — which is the point:
    // Brief 40 §F added `seal` and `seal_alert`, and Brief 35 Fix B §D added `alert_summaries`
    // (the drain that makes "alerts are rate-limited but never dropped" true). An unbounded job
    // would starve the ones behind it exactly as the original overrun starved the integrity scan
    // and the canary sweep, so a new job has to be added here deliberately rather than drift in.
    const bounded = (chain.match(/await boundedJob\(/g) ?? []).length;
    expect(bounded).toBe(11);
    // Stronger than the count alone: the number of jobs and the number of BOUNDED jobs agree, so
    // an eleventh job added without a ceiling fails here even if someone updates the number.
    const jobNames = (chain.match(/boundedJob\('/g) ?? []).length;
    expect(jobNames).toBe(bounded);
    // …and nothing in the cron chain is awaited raw alongside them.
    expect(chain).not.toMatch(/await (escalateDarkDevices|advanceCascades|runIntegrityScan)\(/);
  });

  it('the SSE streams stay long ON PURPOSE — their truncation is recoverable', () => {
    // Pinned so a future reader does not "fix" the longest chain in the worker by
    // shortening it. Its length is safe precisely because nothing depends on it: cut it
    // anywhere and the client reconnects while the 3s poll carries correctness.
    const streams = readFileSync(new URL('../src/routes/contact-streams.ts', import.meta.url), 'utf8');
    expect(streams).toMatch(/MAX_ITERATIONS = 60/);
    expect(streams).toMatch(/latency enhancement/);
    const page = readFileSync(new URL('../src/dashboard/page.ts', import.meta.url), 'utf8');
    expect(page).toMatch(/setInterval\(poll,3000\)/); // the correctness guarantee, still there
  });

  it('handing off is a RETURN, not a break — the DO alarm owns the remaining steps', () => {
    // The DO is armed before the loop, so returning early cannot drop a step: the alarm
    // fires each remaining one at its exact window, and advanceStep keeps it exactly-once.
    expect(notify).toMatch(/await armCascadeSchedule\(env, eventId, workerOrigin\);/);
    const loopStart = notify.indexOf('for (let step = 0; step < contacts.length');
    const armIndex = notify.indexOf('await armCascadeSchedule');
    expect(armIndex).toBeGreaterThan(-1);
    expect(armIndex).toBeLessThan(loopStart); // armed BEFORE any early return can happen
  });
});
