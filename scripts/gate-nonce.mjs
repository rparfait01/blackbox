/**
 * Brief 35 Fix A §C — IS THIS CANARY RUN PART OF A DEPLOY, OR IS IT A DIAGNOSTIC?
 *
 * Extracted from `canary.mjs` for the same reason the headroom check was extracted from
 * `deploy.mjs`: a decision that can only be exercised by performing the expensive thing will not
 * be exercised. Acceptance 9 asks for the attempts to be SHOWN — a forged nonce, a replayed
 * nonce, no nonce at all — and each of those is one line here instead of an eighteen-request
 * round trip against production.
 *
 * THE RULE. A run counts only if it presents a nonce that matches a marker `deploy.mjs` wrote for
 * this run, and the marker is consumed on read. One marker, one pass.
 *
 * THE THREAT IT ACTUALLY ADDRESSES is not an attacker. It is me, twice: the gate stumbled, the
 * environment was still exported, and re-running the canary by hand looked like finishing the job
 * rather than defeating the control. Consuming the marker removes that path — a second run finds
 * nothing and is a diagnostic — while leaving the honest recovery (`pnpm deploy` again) intact.
 *
 * WHAT IT DOES NOT CLAIM. Someone with a shell can write a marker file. No local check survives a
 * determined local operator, and claiming otherwise would be the same lie as a control that
 * reports as enforcing while enforcing nothing. The goal is narrower and achievable: leave no path
 * that can be taken by habit, so that defeating the gate requires a deliberate act.
 */
import { readFileSync, unlinkSync } from 'node:fs';

/** A marker older than this cannot authorise a run — an abandoned deploy is not a licence. */
export const MARKER_TTL_MS = 30 * 60 * 1000;

/** Minimum nonce length. Necessary, and nowhere near sufficient — hence the marker. */
export const MIN_NONCE_LENGTH = 16;

/**
 * Decide, and CONSUME the marker as a side effect. Returns { gated, reason }.
 *
 * `reason` is always populated so a diagnostic run can say WHY it did not count, rather than
 * leaving an operator to guess whether they mistyped something.
 */
export function consumeGateMarker({ nonce, markerPath, now = Date.now() }) {
  if (!nonce || nonce.length < MIN_NONCE_LENGTH) {
    return { gated: false, reason: 'no deploy nonce was presented' };
  }
  let raw;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    return { gated: false, reason: 'no run marker — this nonce was not minted by a deploy, or has already been used' };
  }
  // Consumed whether or not it matches: a marker that has been read is spent, so a wrong guess
  // cannot be followed by a right one.
  try {
    unlinkSync(markerPath);
  } catch {
    /* already gone; the checks below still decide */
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return { gated: false, reason: 'run marker is unreadable' };
  }
  if (marker.nonce !== nonce) {
    return { gated: false, reason: 'nonce does not match the run marker' };
  }
  if (!(now - Number(marker.at) < MARKER_TTL_MS)) {
    return { gated: false, reason: 'run marker has expired' };
  }
  return { gated: true, reason: 'nonce matches the marker minted by this deploy run', build: marker.build };
}
