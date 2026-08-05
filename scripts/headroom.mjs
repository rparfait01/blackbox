/**
 * Brief 35 Fix A §F — REQUEST HEADROOM, ASKED BEFORE THE GATE SPENDS ANYTHING.
 *
 * Verifying a deploy costs real requests against the same plan limit whose exhaustion takes the
 * alert path down. Discovering mid-deploy that there was no budget left for the verification is
 * exactly how a correct deploy gets abandoned and finished by hand — which is the failure this
 * brief exists to close. So the gate asks FIRST, with one request, and refuses to start when the
 * headroom is not there.
 *
 * This lives in its own module rather than inside `deploy.mjs` for one reason: `deploy.mjs` runs
 * its work at import time, so anything defined in it can only be exercised by performing a real
 * deploy. A refusal path that can only be tested destructively will not be tested. Here the
 * decision is a pure function and the read is a plain fetch, so both are provable against a local
 * stub at zero cost against production.
 */

/** Refuse to begin a deploy at or above this fraction of the plan limit. */
export const HEADROOM_REFUSE_ABOVE = 0.9;

/** The smallest Workers daily limit that exists. Below this, no plan can be exhausted. */
export const FREE_TIER_FLOOR = 100_000;

/** States a headroom read can be in. NOT_MEASURED is honest; it is never treated as room. */
export const HEADROOM = {
  OK: 'OK',
  REFUSE: 'REFUSE',
  NOT_MEASURED: 'NOT_MEASURED',
};

/**
 * Decide from an already-fetched readiness `requests` block.
 *
 * ═══ NOT_MEASURED NOW REFUSES. IT USED TO PROCEED. ═══════════════════════════════════════════
 *
 * The original reasoning was that an unconfigured analytics token would block every deploy
 * including the one that ships the fix for it, so NOT_MEASURED was made a distinct state that
 * did not refuse. That reasoning was wrong in the direction that costs the most.
 *
 * What actually happened: CF_ANALYTICS_TOKEN was never set, so EVERY deploy for a week printed
 * "NOT MEASURED" and proceeded. The account reached 80% of its daily request cap without one
 * gate objecting, and the overage was found by a human noticing a bill — not by the control
 * built to notice it. A gate that cannot see the limit is not a gate; it is a log line.
 *
 * An unmeasured metric is not a measurement. The bootstrap problem is real and is solved by
 * BBX_ALLOW_UNMEASURED_HEADROOM=1, which is deliberately awkward, must be typed by a person, and
 * announces itself in the output — so proceeding blind is a decision somebody made rather than
 * the default nobody noticed.
 */
export function headroomVerdict(requests, threshold = HEADROOM_REFUSE_ABOVE, env = process.env) {
  const override = env?.BBX_ALLOW_UNMEASURED_HEADROOM === '1';
  const unmeasured = (why) =>
    override
      ? {
          state: HEADROOM.NOT_MEASURED,
          message: `headroom: NOT MEASURED (${why}) — PROCEEDING because BBX_ALLOW_UNMEASURED_HEADROOM=1. You are deploying blind.`,
        }
      : {
          state: HEADROOM.REFUSE,
          message: [
            '',
            `✗ DEPLOY REFUSED: request headroom could not be measured (${why}).`,
            '  A gate that cannot see the limit is not a gate. Every deploy for a week proceeded',
            '  on this state while the account climbed to 80% of its daily cap.',
            '',
            '  Fix it: set CF_ANALYTICS_TOKEN (Account Analytics:Read) and CF_ACCOUNT_ID.',
            '  Or, to deploy blind on purpose: BBX_ALLOW_UNMEASURED_HEADROOM=1 pnpm deploy',
          ].join('\n'),
        };

  if (!requests || !requests.configured) {
    return unmeasured('no analytics token configured — see Brief 33 Fix A §F');
  }
  // ═══ MEASURED COUNT, UNKNOWN CEILING — A FOURTH STATE, NOT THE SECOND. ═════════════════════
  //
  // Removing the fictional 100,000 denominator made `usedFraction` null, and the unmeasured rule
  // above read that as "we know nothing" and refused every deploy. It is not the same thing: the
  // COUNT is real and displayed; what is missing is a config value.
  //
  // Refusing here would block all deploys until someone types a number, which protects nothing —
  // this account demonstrably serves a million requests a day. But proceeding with no ceiling at
  // all is the blind-default this brief exists to remove.
  //
  // So it proceeds against the SMALLEST PLAN THAT EXISTS. Below that floor no plan of any tier
  // could be exhausted, so there is provably room whatever the real limit turns out to be. Above
  // it, we genuinely do not know, and it refuses.
  if (requests.limit == null && typeof requests.used === 'number') {
    if (requests.used >= FREE_TIER_FLOOR * HEADROOM_REFUSE_ABOVE) {
      return {
        state: HEADROOM.REFUSE,
        message: [
          '',
          `✗ DEPLOY REFUSED: ${requests.used.toLocaleString()} requests today and PLAN_DAILY_REQUESTS is not set.`,
          `  Past ${Math.round(FREE_TIER_FLOOR * HEADROOM_REFUSE_ABOVE).toLocaleString()} we cannot say there is room without knowing the plan.`,
          '',
          '  Set PLAN_DAILY_REQUESTS to this account’s real daily limit.',
        ].join(String.fromCharCode(10)),
      };
    }
    return {
      state: HEADROOM.OK,
      message: `headroom: ${requests.used.toLocaleString()} today · UNKNOWN PLAN — under the ${FREE_TIER_FLOOR.toLocaleString()} floor, so there is room on any plan`,
    };
  }

  const used = requests.usedFraction;
  if (used == null) {
    return unmeasured('analytics returned no count');
  }
  if (used >= threshold) {
    return {
      state: HEADROOM.REFUSE,
      usedFraction: used,
      message: [
        '',
        `✗ DEPLOY REFUSED: request headroom is ${Math.round(used * 100)}% of the plan limit.`,
        '  The gate itself spends requests, and the alert path fails when the limit is reached.',
        '  This is BILLING, not infrastructure. Raise the plan or wait for the daily reset.',
        '  Re-run `pnpm deploy` once there is room — nothing has been published.',
      ].join('\n'),
    };
  }
  return { state: HEADROOM.OK, usedFraction: used, message: `headroom: ${requests.summary}` };
}

/**
 * Read the readiness panel's `requests` block. Returns null — never a guess — when it cannot be
 * read, for the same reason the Worker-side module does: an invented headroom figure is worse
 * than none, because it is the number an operator relies on before assuming they have room.
 */
export async function readHeadroom(apiOrigin, token) {
  if (!token) return null;
  try {
    const res = await fetch(`${apiOrigin}/v1/admin/encryption/readiness`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.requests ?? null;
  } catch {
    return null;
  }
}
