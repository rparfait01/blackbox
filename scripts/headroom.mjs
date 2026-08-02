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

/** States a headroom read can be in. NOT_MEASURED is honest; it is never treated as room. */
export const HEADROOM = {
  OK: 'OK',
  REFUSE: 'REFUSE',
  NOT_MEASURED: 'NOT_MEASURED',
};

/**
 * Decide from an already-fetched readiness `requests` block.
 *
 * NOT_MEASURED does NOT refuse. That is a deliberate call and worth stating: an unconfigured
 * analytics token would otherwise block every deploy, including the deploy that ships the fix
 * for it. What it must never do is report as room — hence a distinct state rather than a
 * cheerful default, and a message that says plainly that nothing was measured.
 */
export function headroomVerdict(requests, threshold = HEADROOM_REFUSE_ABOVE) {
  if (!requests || !requests.configured) {
    return {
      state: HEADROOM.NOT_MEASURED,
      message: 'headroom: NOT MEASURED (no analytics token configured — see Brief 33 Fix A §F)',
    };
  }
  const used = requests.usedFraction;
  if (used == null) {
    return { state: HEADROOM.NOT_MEASURED, message: 'headroom: NOT MEASURED (analytics returned no count)' };
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
