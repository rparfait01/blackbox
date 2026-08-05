import { describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs deploy script, no type declarations
import { HEADROOM, headroomVerdict } from '../../../scripts/headroom.mjs';

/**
 * BRIEF 33 FIX C — AN UNMEASURED METRIC IS NOT A MEASUREMENT.
 *
 * `CF_ANALYTICS_TOKEN` was never set, so every deploy for a week printed "headroom: NOT MEASURED"
 * and proceeded. The account reached 80% of its daily request cap and not one gate objected; the
 * overage was found by a human noticing a bill, not by the control built to notice it.
 *
 * These are behavioural, per the ratified rule: a guard could assert that the string
 * "NOT_MEASURED" appears in this file and pass on every implementation, including the one that
 * proceeded. What matters is the VERDICT the function returns.
 *
 * IT LIVES IN THE PWA WORKSPACE, not beside the script it tests. `pnpm -r test` runs workspace
 * packages only, and `scripts/` is not one — a test file there executes on no run of the suite,
 * which is the same class as a test that cannot fail. The deploy-gate guard already reaches these
 * scripts from here for exactly that reason.
 */
describe('an unmeasured headroom refuses', () => {
  const noEnv = {};

  it('an unconfigured analytics token REFUSES the deploy', () => {
    const v = headroomVerdict({ configured: false }, 0.9, noEnv);
    expect(v.state, 'a gate that cannot see the limit is not a gate').toBe(HEADROOM.REFUSE);
    expect(v.message).toMatch(/could not be measured/);
  });

  it('a configured token that returns no count also REFUSES', () => {
    // Reachable independently: the token exists but analytics answered with nothing. Same
    // epistemic position, same answer.
    const v = headroomVerdict({ configured: true, usedFraction: null }, 0.9, noEnv);
    expect(v.state).toBe(HEADROOM.REFUSE);
  });

  it('a missing requests block REFUSES rather than reading as room', () => {
    expect(headroomVerdict(null, 0.9, noEnv).state).toBe(HEADROOM.REFUSE);
    expect(headroomVerdict(undefined, 0.9, noEnv).state).toBe(HEADROOM.REFUSE);
  });

  it('the refusal names the two things needed to fix it', () => {
    const v = headroomVerdict({ configured: false }, 0.9, noEnv);
    expect(v.message).toMatch(/CF_ANALYTICS_TOKEN/);
    expect(v.message).toMatch(/CF_ACCOUNT_ID/);
  });
});

describe('the bootstrap escape is explicit and loud', () => {
  it('BBX_ALLOW_UNMEASURED_HEADROOM=1 proceeds, and says it is blind', () => {
    // The original objection was real: an unconfigured token would block the deploy that ships
    // the fix for it. The answer is an override a person has to type, not a default nobody sees.
    const v = headroomVerdict({ configured: false }, 0.9, { BBX_ALLOW_UNMEASURED_HEADROOM: '1' });
    expect(v.state).toBe(HEADROOM.NOT_MEASURED);
    expect(v.message).toMatch(/PROCEEDING/);
    expect(v.message, 'the override must announce what it is doing').toMatch(/deploying blind/i);
  });

  it('any other value does NOT unlock it', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(headroomVerdict({ configured: false }, 0.9, { BBX_ALLOW_UNMEASURED_HEADROOM: value }).state).toBe(
        HEADROOM.REFUSE,
      );
    }
  });
});

describe('measured headroom is unchanged', () => {
  it('below the threshold proceeds', () => {
    const v = headroomVerdict({ configured: true, usedFraction: 0.42, summary: '42k of 100k' }, 0.9, {});
    expect(v.state).toBe(HEADROOM.OK);
  });

  it('at or above the threshold refuses, and says it is billing', () => {
    const v = headroomVerdict({ configured: true, usedFraction: 0.91 }, 0.9, {});
    expect(v.state).toBe(HEADROOM.REFUSE);
    expect(v.message).toMatch(/BILLING, not infrastructure/);
  });

  it('the override does NOT bypass a real over-threshold reading', () => {
    // It excuses "I could not measure", never "I measured, and there is no room".
    const v = headroomVerdict({ configured: true, usedFraction: 0.95 }, 0.9, {
      BBX_ALLOW_UNMEASURED_HEADROOM: '1',
    });
    expect(v.state).toBe(HEADROOM.REFUSE);
  });
});
