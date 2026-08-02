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

## BRIEF CONVENTION (Brief 34 §1/§2 — non-negotiable, from Brief 035 forward)

- **Every brief opens with `## CORRECTIONS`, before scope, before context, before anything.**
  A brief that supersedes nothing writes `## CORRECTIONS — None.` A missing block is a defect
  and the brief is rejected. Enforced mechanically: `scripts/supersession-index.mjs --check`
  runs FIRST in the pre-push gate, before anything that costs a network request.
- **New text only.** The correction IS the current reading. Never state what the prior text
  said — a reader arriving at the newest brief must need nothing earlier. A block that
  narrates the old wording is a delta, and deltas force the reader backward, which defeats
  the whole convention.
- **One correction per entry**, machine-findable address (zero-padded brief number, section,
  step), plus the file path when it lands in code.
- **Cumulative-safe.** Correcting text that was already corrected restates the current reading
  IN FULL.
- **A correction is not a fix.** The block records what a statement now SAYS; the body records
  what the code must now DO. A brief that corrects a claim without fixing the behaviour says
  so explicitly.
- **One brief, one type** — FIX / BUILD / REMOVAL / VERIFY / GOVERNANCE. A brief that fixes
  and builds is two briefs.
- **A fix to something a prior brief shipped carries that brief's number with a revision
  suffix** (`BRIEF_033_FIX_A`). Only new capability takes a new number, so a defect and its
  fix stay one lineage. Subdivisions are `§A/§B/§C` inside one file, never separate documents.
- **Both dependency directions are mandatory**: `**REQUIRES:**` and
  `## CARRIES FORWARD (open, owned by)`. One alone is a gap — REQUIRES without CARRIES FORWARD
  lets work fall between two briefs that each assumed the other had it.
- `SUPERSESSION_INDEX.md` is **generated, never hand-maintained**. A hand-written index drifts
  the first time someone is in a hurry, and a drifted index answers confidently and wrongly.

## DESTRUCTIVE = GUARDED
- Restore point before any destructive prod operation.
- **The custody chain is never purged.** Only the objects it attests to are purged, on
  recorded owner consent. Deleting evidence and erasing the record that it existed are
  different acts, and only the first is ever authorised by an owner's consent to a purge.
  A purge leaves the integrity chain, the events, and an audit row naming the restore point.
- **A restore point must cover the thing being destroyed.** D1 Time Travel restores index
  rows only — never R2 bytes. A bookmark alone is not a restore point for media; export and
  size-verify the objects first, or say plainly that the bytes are unrecoverable.
- **The Worker's own binding is the only authority for R2 state.** `wrangler r2 object
  get/delete` reads and writes a LOCAL miniflare simulator (`.wrangler/state/v3/r2/`), so a
  deleted object still "downloads" from the shadow copy and a delete can report success
  having done nothing. Verify through the deployed Worker, and delete the local shadow copy
  afterwards — it is an unintended second copy of whatever was just purged.
- Dry-run/preview by default; explicit confirm required; malformed/empty input never triggers a mass action.
- Every destructive action audited: who, what, when.

## ENCRYPTION
- Until Brief 47 is green, **no document states that capture is encrypted.** The readiness
  panel (`GET /v1/admin/encryption/readiness`) is the only authority on what is actually
  true; a flag reports intent, counts report the world, and those two disagreed for two
  months without anything saying so.
- The covert retention signal is a per-account BREATHING CADENCE and appears in no
  public-safe or pre-patent document. A published tell is not a tell.
- The canary encrypts through the real path, with no exemption. The two envelope
  implementations are pinned byte-for-byte by shared vectors in CI
  (`envelope-crossverify.test.ts`); if they can drift, the gate proves nothing.

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
