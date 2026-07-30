# STANDING ENGINEERING CONSTRAINTS — APPLY TO EVERY BRIEF

**These are non-negotiable and apply to every brief without being restated. CC operates under all of them at all
times.**

## NO LOOSE ENDS
- **A brief closes every gap it surfaces.** If CC finds a related defect while working, it fixes it in the same
  brief or names it explicitly as a required follow-up brief before marking done — never leaves it dangling.
- **No "flagging for later" without a closing plan.** If something can't be closed now, the report states exactly
  what closes it and when — not "worth knowing."
- If a fix reveals a second gap, that gap is either closed or explicitly briefed. The work isn't done while a
  known gap is open.

## ROOT CAUSE, NOT PATCH
- Fix the cause, not the symptom. No band-aids, no special-case branches papering over a design fault.
- If the same class of failure has appeared before, the fix must prevent the whole class, not the instance.

## PROVE, DON'T ASSERT
- Every `[L]` claim is proven on the live deployed worker/device — real bytes, real requests, real responses.
  Not row counts, not "tests pass," not desktop-only.
- Concurrency, atomicity, and boundary claims need adversarial proof (race tests, cross-scope attempts), not a
  happy-path pass.
- Re-list/re-verify after any command that can silently fail. Never trust an exit code alone.

## SAFETY FLOOR IS SACRED
- Trigger always fires — zero entitlement/gate/auth checks in trigger/capture/dispatch. Grep-proven every time.
- Capture retention is never suspended to accomplish anything else.
- Honest status always — never claim delivery/success that didn't happen; never a silent failure.
- §0a Hidden facade byte-identical on every brief that touches the client.

## DESTRUCTIVE = GUARDED
- Restore point before any destructive prod operation.
- Dry-run/preview by default; explicit confirm required; malformed/empty input never triggers a mass action.
- Every destructive action audited: who, what, when.

## DEPLOY DISCIPLINE
- Migration to prod first, deploy second, never reversed.
- Both halves currency-asserted (Pages == Worker == intended hash) before "done."
- Clean tree — no dirty-provenance deploys.
- The test suite never consumes production delivery quota (reserved-address suppression holds).

## MANUAL ACTIONS GET DESIGNED OUT
- Anything currently requiring Royce to run a curl or type a token is a temporary state, not an accepted one.
  The end state is a button in the operator console. Every manual maintenance action must have a planned home in
  the dashboard maintenance panel.

## REPORT FORMAT
- GOOD / BAD / CORRECT-FOR-REPAIR. Terse. Root-cause named. Evidence per claim.
- State what deploys BEFORE deploying it — no riders discovered after the fact.
- Every open item ends with who closes it and how — never an orphan flag.
