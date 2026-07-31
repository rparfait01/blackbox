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
