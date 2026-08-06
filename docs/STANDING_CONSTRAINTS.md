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

---

## TOOLCHAIN (ratified 2026-08-02, from Brief 35 Fix A §A)

**No build or deploy step invokes a tool from the network.** Every tool is a pinned dependency,
invoked from the directory where it is declared. If `npx` resolves it from the registry, the
pipeline is wrong.

**A declared version is not an installed version.** The pipeline reports the version it actually
ran, and a mismatch with the manifest fails the deploy.

*Why this is standing rather than a one-off fix:* `deploy-pages.mjs` ran `npx wrangler` from the
repository root, which declares no wrangler, so npx fetched one from the registry. The client
half of every production deploy was published by 4.99.0 off the network while `package.json`
declared 4.118.0. Nothing failed and nothing warned, because the two numbers were never printed
next to each other — so the honest answer to "which wrangler published production?" was
"whatever the registry served that morning". This is the same class as a cost line that always
reads zero: a value that looks authoritative while being structurally unable to reflect reality.

Enforced by `scripts/toolchain.mjs`, called from the Brief 35 deploy gate before anything is
built. Guarded by `apps/pwa/src/deploy-gate.guard.test.ts`.

---

## COMPARISONS (ratified 2026-08-02, from Brief 30 Fix A)

**A new comparison requires proving the comparing side can produce the value. Both sides are
exercised before ship — a case that passes and a case that fails. A guard that always refuses and
a guard that always permits are the same defect in opposite directions, and neither is visible to
a typecheck. Third occurrence: `!undefined` in canary.mjs, `!proven.ok`, and `claims.bind` against
an always-undefined `opts.bind`.**

Each of the three typechecked, linted, and read correctly in review:

| | Direction | Consequence |
|---|---|---|
| `!proven.ok` after the return shape changed | always refuses | the deploy gate would have failed **every** deploy, including correct ones |
| `isOurBuild` with `^{commit}` eaten by cmd.exe | always refuses | ordinary propagation classified `WRONG_ARTIFACT` — terminal, no retry |
| `claims.bind` vs an `opts.bind` no route supplied | always refuses | signup broken end to end; nobody could create an account |

**Fail-open on the life-safety paths.** On the signup path, refuse-everyone is an outage. On the
alert path it is a survivor who cannot call for help. Any new comparison on the **trigger,
capture, cascade, or closure** path fails OPEN by default and is proven both ways before ship.
Availability of the alert path outranks every other property it has — that is already why the
capture envelope fails open to plaintext rather than dropping a recording.

---

## DERIVED VALUES AND ISOLATE STATE (ratified 2026-08-02)

**Readiness panel values are derived from what the system observes. Never written as literals.**
Fourth occurrence of the class: the panel hardcoded `retentionRule: 'NOT PROVISIONED — no
storage-layer lock exists yet'` and went on saying it after the lock was provisioned. Earlier
three: `isFinal:false` hardcoded so every capture read truncated; a default that told five closed
events "capture in progress"; `ENVELOPE_ENCRYPTION_ENABLED` reading armed while encrypting
nothing. Where the runtime genuinely cannot observe a value — the Workers runtime cannot read an
R2 lock rule from a binding — the panel states what is CONFIGURED and names where it is VERIFIED,
and never implies it checked.

**An isolate's current configuration is not a global fact. Where a value must match across a
request pair, carry the value that produced it — never re-derive from whatever is current now.
Secret propagation across isolates is not atomic.** Observed: a signup capability minted seconds
earlier was refused, because the binding commitment was recomputed with `capabilityKeys(env)[0]`
and the two requests landed on isolates that disagreed about the current key. The fix is general —
verification keeps the key that matched the signature and recomputes with that.

**A guard asserts against observed state, not a remembered string. A guard that keeps passing
after the world moved is not guarding anything.** Occurrences: `signingFixture()`, and the Brief
40 assertion that the panel says "NOT PROVISIONED" about a rule that is provisioned.

**Run `pnpm test`, not `npx vitest` inside one package.** The repo has two test packages and the
worker's is where server guards live. Two stale guards survived a full session of green runs
because only `apps/pwa` was being exercised.

## VACUOUS PASSES (ratified 2026-08-02, from Brief 37 Fix A)

**A check that passes because there was nothing to check is not a passing check.** An empty set is
the absence of evidence, not evidence of correctness, and a verifier must say which of the two it
is looking at. Occurrences found by the Brief 37 Fix A sweep:

| Site | Was | Now |
|---|---|---|
| `verifyChain` on an unknown event id | `VERIFIED — no records to verify` | `EVENT_NOT_FOUND` |
| `verifyChain` on a real event with no records | `VERIFIED — no records to verify` | `NO_RECORDS` |
| migration health (`console.ts`) | `ok: pending.length === 0` — could only see manifest ahead of DB | also fails on applied-but-unlisted |
| readiness vault summary | `VAULT: 0/0 objects verified` — read healthy for two months while nothing had EVER been sealed | `VAULT: EMPTY — no sealed objects exist to verify` |

Swept and found CLEAN: `canary /status` (`routable.length === 0` — empty genuinely is the safe
state), `suppression.ts` and `capture-encryptor.ts` (both guard length before `.every()`, so
neither is vacuously true), the event HMAC path (`maxSkewMs = 300_000` bounds replay).

---

## GUARDS ASSERT STRUCTURE (ratified 2026-08-03, from Brief 2 Fix A)

**A guard asserts against parsed structure — AST, exported symbols, config values. Never source
text, never comments. A comment is not an interface.**

Sixth occurrence is why this is tooling rather than advice. Every one was written by someone who
knew the rule:

| # | Where | Shape |
|---|---|---|
| 1–4 | Briefs 37, 39, 49, 35 Fix A | negative assertion failed because the comment EXPLAINING the defect contains the defect's text |
| 5 | session-persistence guard | asserted a remembered token shape, broke on a change it does not govern |
| 6 | deploy-gate guard | ordering compared a file-header sentence to a call 7,600 chars later |
| 7 | trigger-persist guard | sliced a code range using `indexOf('// Seed the first location')` — a comment used as a structural landmark |

Enforced by `test-utils/guard-source.mjs` (`code` / `prose` / `json` / `exportsOf` / `callOrder`)
and the meta-guard `workers/api/test/guard-hygiene.guard.test.ts`, which FAILS on any new guard
that reads source without stripping. Existing debt is an explicit list that may only shrink, and
the meta-guard also fails if a converted file is left on it — otherwise an allowlist becomes the
permanent exemption it was meant to retire.

**The dangerous direction is not the noisy one.** A negative assertion that fails on a comment
announces itself. A POSITIVE assertion satisfied by a comment is a guard reporting green while
guarding nothing — the same shape as a cost line that always reads zero.

`prose()` exists and is legitimate: "the §D limits are written down" is a real, checkable
property. It must be named at the call site so a reader knows which was meant.

## THE DEPLOY VERIFIES ITS OWN PRECONDITION (ratified 2026-08-03, Brief 35 Fix A §C corrected)

**The deploy refuses to run unless the test suite passed in the same invocation, verified by the
deploy script itself, not by shell operator precedence. A gate a shell operator can skip with `;`
instead of `&&` is the same defect as a gate a human can finish by hand.**

`pnpm deploy` now runs `pnpm verify` in-process before anything is published. There is no skip
flag, for the same reason `--skip` does not exist on the canary. Occurrence: a `;` in a command
chain deployed a build whose test suite had failed.

## A VERDICT NEEDS A CODE PATH (ratified 2026-08-03, from Brief 37 Fix A)

**"A verdict the system can report must have a code path that produces it. A state reachable only
by hand is not a feature — it is a document describing something that does not exist."**

(PURGED_BY_CONSENT, pre-37 Fix A: the outcome Brief 40 §0's reconciliation rested on was reachable
exactly once, manually.)

`verifyChain` READ an audit row with action `chunks.purged_owner_consent`; nothing anywhere WROTE
one. The five production events carried that verdict only because the row was inserted by hand at
13c539f. The whole operator-binding/owner-custody reconciliation — the thing that made a 36-month
retention lock compatible with a survivor's right to destroy her own recordings — rested on a
state the product could not enter. Closed by `POST /v1/me/events/:id/purge-capture`.

## MAKE THE UNSAFE STATE UNREPRESENTABLE (ratified 2026-08-03, from Brief 2 Fix A)

**"Make the unsafe state unrepresentable, not merely wrong. DEVICE_CREDENTIAL_ENFORCED cannot
express armed-but-accepting-userHash. Four prior occurrences shipped a flag reading armed while
behaving disarmed: 0038, 0049, expectedPublicKey, ENVELOPE_ENCRYPTION_ENABLED."**

The pattern in each: a single global boolean claimed a property the code did not enforce, and
nothing could detect the divergence because the flag was the only thing anyone consulted. The
correction is structural rather than vigilant — arming is a per-account timestamp
(`users.deviceCredentialArmedAt`) and the flag only decides whether that timestamp may be SET, so
there is no value the pair can take that means "armed everywhere but still accepting the old
credential". The state does not exist to be shipped by mistake.

## ALLOW-LIST, NEVER DENY-LIST (ratified 2026-08-03, from Brief 41)

**"Safety-critical exemption is an allow-list, never a deny-list. A path is unlimited,
unthrottled, or ungated because it was never added — not because someone remembered to exempt it.
A deny-list silently captures every route added after it was written, and that failure is
invisible until the day it matters."**

*(Origin: Brief 41 `LIMITED` / `ruleFor()` returning null for anything absent.)*

## MEASURE WHAT THE CONTROL ACTS ON (ratified 2026-08-03, from Brief 41 §F)

**"A measurement must measure the thing the limit acts on. A per-path total says nothing about a
per-identifier bucket, and reporting one as the other condemns a correct control or exonerates a
broken one."**

*(Origin: Brief 41 §F reporting 149 signups against a burst of 12 — 149 distinct identifiers, one
attempt each.)*

## TEST HARNESSES ASSERT THEIR OWN SETUP (ratified 2026-08-03, from Brief 35 Fix B)

**"A test harness asserts its own setup succeeded. An unchecked non-2xx during setup makes every
downstream reading meaningless — an empty address book reads as a failed cascade, and a test that
can never pass is the mirror of a test that cannot fail."**

*(Origin: `/v1/me/contacts/1` against named slots; `@nonexistent.invalid` suppressed as a reserved
TLD before reaching the cap.)*

**"A reserved or sentinel value is inert by design. A test that drives a control with one proves
the control was never reached."**

Both were live: several dispatch proofs reported "0 delivery rows" when the real state was "no
contact was ever saved", and a cap-draining run reported "0 counted" when the address had been
suppressed two checks earlier. Neither failure announced itself — each read as a finding about
the system rather than about the harness.

## SECURITY COUNTERS LIVE IN DURABLE STORAGE (ratified 2026-08-03, from Brief 41 §D)

**"Any counter a security decision depends on lives in durable storage, not isolate memory.
Isolate-local state answers a question about one isolate, which is never the question being asked.
Second occurrence of the isolate class: the capability key rotation recomputing against whatever
key was current, and the rate limiter counting refusals per isolate so a targeted attack on one
survivor never crossed the alert threshold."**

## A GUARD ASSERTS ITS LANDMARKS (ratified 2026-08-03, from Brief 35 Fix B)

**"A guard that extracts a region of code asserts its landmarks were found. A slice whose start or
end marker is absent silently runs to end-of-file and the guard tests nothing. Test the property,
not the spelling."**

*(Origin: the hot-path guard bounded by a comment `code()` had already stripped — the same mistake
made twice inside a guard written to enforce the rule against it.)*

## AN AUDIT REPORTS ITS SCOPE (ratified 2026-08-03, from Brief 42 §A)

**"An audit reports the scope it inspected. A tool that examines a subset and returns an
unqualified pass is asserting about what it never read. Fourth instance of the vacuous-pass class:
VERIFIED on an empty chain, 0/0 objects verified, migration health seeing only one direction, and
a CSP audit that read no stylesheets."**

The CSP instance is the sharpest, because the tool was written specifically to answer "will this
policy break the facade?" and returned a confident green while never opening the file where
`@font-face` lives. Six `data:` font URIs would have been blocked on enforcement, changing the
Hidden facade's typography — a covert-mode failure — and the audit had no idea because it read
only `.js`.

## GUARDS ASSERT THE INVARIANT (ratified 2026-08-03, from Brief 42 §C)

**"A guard asserts the invariant, not the implementation. Parsed structure is necessary but not
sufficient — a guard pinned to an exact query string fails on a change that does not touch what it
governs. Assert the property, not the spelling."**

Companion to the parsed-structure rule, and a correction to it: stripping comments stops a guard
matching prose, but it does nothing about a guard matching the wrong thing precisely. A tenancy
guard pinned to `SELECT sessionsValidFrom, orgId FROM users WHERE id = ?` broke when a revocation
subquery joined the same statement — a change that does not touch where `orgId` comes from. The
property is "orgId is read from the users row and never parsed out of the token", and that is what
it asserts now.

## A CONTROL APPLIES TO AN ORIGIN (ratified 2026-08-03, from Brief 42 §D)

**"A control applies to an origin, not to a product. Where a system spans more than one origin,
every control is enumerated per origin and the coverage is asserted. A header file that protects
the static origin while the API origin serves the sensitive URL is a control applied to the place
someone was looking rather than the place it mattered."**

*(Origin: `_headers` is a Cloudflare Pages file; the coordinator dashboard is served by the
Worker, which had no security headers at all — so the one origin whose URL carries an event-bound
magic token was the one with no referrer policy.)*

## THE ENVIRONMENT IS A TEST INPUT (ratified 2026-08-03, from Brief 43 §D)

**"The environment is a test input. Timezone, locale, and clock are assumptions a test makes
silently, and a suite that only ever runs in one of them cannot catch a bug in the others. Date
and time behaviour is exercised across at least two zones, one of them offset across a date
boundary from the other. This machine's Asia/Tokyo made getUTCDate and getDate identical for the
tested instant, so both the vacuous test and its replacement were invisible."**

*(Measured, 2026-08-03. The standing second-zone pass — `pnpm test:tz`, America/Los_Angeles —
found NOTHING new: 1,261 tests pass identically in both zones. That is not a null result and must
not be read as one. The evidence for the rule is the injection: replacing `getUTCDate` with
`getDate` in the evidence label produced **1 failure under Asia/Tokyo and 5 under
America/Los_Angeles**. Four behavioural tests were blind on this machine, including the one
asserting the rendered label. A clean second-zone run means the zone-dependent bugs are absent
today, not that the pass is unnecessary — it is the reason we know that.)*

## A THROW INSIDE A FAIL-OPEN BOUNDARY IS A BYPASS (ratified 2026-08-03, from Brief 43 §C)

**"Inside a fail-open boundary, every throw is a silent bypass of the control that boundary
protects. Fail-open is correct on the alert path and it converts crashes into permissions. Code
inside one is total by construction, and a throw there is a defect of the same severity as the
bypass it produces."**

*(Origin: `deviceCanonical` threw on a null method. The server-side call sits inside the capture
path's fail-open catch — correct, because an infrastructure failure must never cost a survivor her
evidence — which means the throw never surfaced as an error. It converted a `REFUSED` verdict into
`ACCEPTED_FAIL_OPEN`. Anything that can make that code throw is a way to switch device
verification off. Latent rather than live at the one call site, and closed anyway: on these paths
the severity of a crash is the severity of the permission it grants.)*

## A JOB REPORTS WHAT IT EXAMINED (ratified 2026-08-03, from Brief 23 Fix A §F5)

**"A job reports what it examined, not only what it changed. '0 changed' and '0 examined' are
different facts, and a report that cannot distinguish them is a report that a stalled job is a
finished one. A resumable cursor states, on every run, whether it made a full pass or resumed —
and full is the default."**

*(Origin: the org-attribution backfill always resumed from its recorded cursor, so a table marked
complete was never scanned again — rows created afterwards whose keys sorted before the cursor
were skipped forever. It printed "0 attributed" and exited 0, which reads as "nothing needed
doing" rather than "I did not look". Silent under-attribution on the operations surface an
institutional contract depends on, and it was invisible precisely because the two facts shared
one number.)*

## EVERY ACTION AGAINST PRODUCTION STATES ITS COST (ratified 2026-08-04)

**"Every action against production states its request cost before it runs. A session has a stated
ceiling and stops at it. A backfill is not free, and neither is an investigation."**

Operating rules, effective immediately and every session:

1. **State the request cost BEFORE running anything that touches production.** If it cannot be
   estimated, it does not run.
2. **Hard ceiling: 5,000 metered requests per session.** Stop at the ceiling and report. Do not
   continue past it.
3. **The full acceptance suite (~1,431 requests) runs ONCE, immediately before a production
   deploy.** Not per brief. Not per section. Not to re-check something that passed an hour ago.
   **During a brief, run only the checks that touch what changed, and state which and why.**
   A check that passed and whose code has not changed does not run again — re-running it buys
   no information and spends the same plan limit the alert path depends on.
4. **Staging for everything except the final deploy.** Production gets one migration if needed,
   one deploy, one canary. Nothing else.
5. **No row-iterating job on production without explicit go-ahead**, with the row count and
   request cost stated first.
6. **Investigation and inventory are read-only against the repo and schema** — never against live
   production endpoints.

*(Origin: a single session spent roughly 10,400 metered requests. Seven full acceptance runs where
the rule allows one — two of them wasted on a stale-target failure I caused by deploying with the
wrong stamp. A 10,437-row production backfill run with neither a row count nor a cost stated
beforehand. The plan limit whose exhaustion takes the alert path down is the same limit these runs
draw on, which makes an untracked test budget a life-safety concern rather than a billing one.)*

## CHANNELS ARE ADDITIVE (ratified 2026-08-04)

**"Channels are additive. No delivery channel is ever retired in favour of another. Every channel
a contact holds is used."**

Multi-channel is the design, not a migration to be completed. Email has no carrier, no A2P
registration and no delivery gate, which makes it the channel most likely to survive when the
others fail. A contact reachable on more channels is more likely reached.

*(Origin: the notification brief §1 marked email as RETIRING from the alert path — "flip this to
false once SMS delivers" — on the grounds that it is a single-vendor cap that had silently failed
twice. Both facts were true and neither supported removing the channel: the failure was a QUOTA
failure, and quota is answered by adding a second channel alongside, never by deleting the first.
Had the flag been flipped when SMS was provisioned, two production contacts holding only an email
endpoint would have gone dark with nothing in the system saying so.)*

## A CHECK CALLS THE ROUTE THE WAY THE CLIENT DOES (ratified 2026-08-04)

**"An acceptance check calls the route the way the client calls it. A check that supplies
credentials the real client does not send tests a path no browser takes."**

*(Origin: `claim-coordinator` was called by the suite as
`POST /v1/c/:id/claim-coordinator?t=<token>` — an explicit token the page never sends. After the
Brief 33 Fix B redirect the page had no token at all, so every real claim 401'd while the suite
stayed at 102/102. The check exercised a path no browser takes, so it could not have caught it.)*

## A ROUTE VERIFIES THROUGH THE SHARED HELPER OR IT DOES NOT VERIFY (ratified 2026-08-04)

**"A route verifies through the shared helper or it does not verify. A second private verification
path drifts from the first, and the drift is invisible until it is a live P0."**

*(Origin: every `/v1/c/:id/*` route authenticates through `requireMagicToken`, except
`claim-coordinator`, which read `c.req.query('t')` and called `verifyTokenRole` itself. When
`requireMagicToken` learned to accept the `bbview` cookie, every route learned it except that one.
The result was that no coordinator could take coordination and — because `isSupportEngaged()` is
derived from the claim — every event closed on a single party with dual consent bypassed.)*

## BUILD THE INSTRUMENT BEFORE THE INTERVENTION (ratified 2026-08-04)

**"Build the instrument before the intervention. A count you cannot defend is worse than no count,
because it gets planned against."**

*(Origin: Brief 54 §0 asked for a per-assertion classification of ~770 guard assertions. Three
regex passes produced 802, then 38, then 770-with-wrong-classes — each confidently wrong in a
different direction. The instrument that could answer "does this assertion read source text" was
the AST helper the brief itself specified, so it was built FIRST and used to measure. The class
split turned out not to be automatable at all: `/STOP/` and `/return <Navigate/` are both regexes
over source, and only intent distinguishes copy from render behaviour. Reported as judgment work
with its cost, rather than as a fourth heuristic dressed as a table.)*

## THE PRODUCT TAKES THE SCARCE RESOURCE FIRST (ratified 2026-08-04)

**"The subsystem whose output is optional never acquires a scarce device resource before the
subsystem that is the product."**

*(Origin: Brief 55 §C. `transcription.start()` sat one line above `capture.start()` in the
activation sequence. Web Speech opens its OWN microphone — a second, wholly independent
acquisition — and on iOS Safari holding it is enough to make the following getUserMedia fail. So
on every activation ever shipped, the transcript was first in the queue for the device and the
recording was second. A covert event then ran 74 seconds and stored ZERO chunks: the OS refused
the page a microphone, MediaRecorder was never constructed, and the alert dispatched, cascaded and
closed normally with no evidence behind it at all.*

*A transcript with no recording behind it is a text file. A recording with no transcript is still
evidence. Order that carries no syntactic weight — nothing looks wrong with the two lines swapped,
nothing fails to compile, no test notices — is exactly the kind of property that needs a guard
rather than a comment: `apps/pwa/src/capture-acquisition-order.guard.test.ts`.)*

## A GUARD CANNOT ASSERT A BEHAVIOUR (ratified 2026-08-05)

**"A guard cannot assert a behaviour. A catch that rethrows satisfies a guard asserting a
try/catch exists while inverting what it guards. Behaviour is proven by a test that fails when the
fix is reverted."**

*(Origin: Brief 56 §A3. `advanceStep` had to SEND when it could not read whether a coordinator had
claimed — fail-open on the alert path. A source-reading guard can assert that a `try/catch`
surrounds the D1 call, and every wrong implementation satisfies that: a catch that rethrows, a
catch that returns false, a catch that logs and falls through. Each one passes the guard and
suppresses the dispatch, which is the failure the section exists to prevent.*

*So it is a behavioural test: the D1 stub is made to throw and the test observes that the cascade
driver survives and the step still goes. Its counterpart — `changes === 0` must still HALT — is
tested too, because a fix that returned true unconditionally would pass the first test and destroy
the halt entirely. Both were verified by reverting the fix and watching the test fail.*

*This does not retire guards. It bounds them: guards assert STRUCTURE — what is imported, what is
called, what is absent. Behaviour under a failure mode is only ever proven by producing the
failure.)*

## A STOP CONDITION IS EVALUATED ON EVERY OUTCOME (ratified 2026-08-05)

**"A loop's stop condition is evaluated on every outcome, including failure. A stop condition
reachable only on the success path means a failing loop runs forever, and it fails silently
because nothing on screen changes."**

*(Origin: Brief 33 Fix C. The coordinator dashboard polled `/state` every 3 seconds and did
`r.ok ? r.json() : null`, then rescheduled on null. The one instruction that stops it —
`terminal: true` — was reachable only through a parsed 200 body. Magic tokens live one hour, so
every dashboard tab left open flipped to 401 and then polled 28,800 times a day, invisibly,
forever. The notified view had the identical defect at 5s, and the LINE pairing screen a third
copy at 2.5s with the comment "transient; keep polling".*

*Two mitigations already existed and both were delivered in a dialect the client could not read:
the runaway-poll ceiling answered 429 and the expired session answered 401, and the loop treated
both as "no data, try again". A refusal a client ignores is not a refusal, whatever the status
number says.)*

## AN UNMEASURED METRIC IS NOT A MEASUREMENT (ratified 2026-08-05)

**"An unmeasured metric is not a measurement."**

*(Origin: `headroomVerdict` returned NOT_MEASURED and did not refuse, reasoning that an
unconfigured analytics token would otherwise block the deploy that ships the fix for it.
CF_ANALYTICS_TOKEN was never set, so every deploy for a week printed "headroom: NOT MEASURED" and
proceeded, and the account reached 80% of its daily request cap without one gate objecting. It was
found by a human noticing a bill, not by the control built to notice it.*

*NOT_MEASURED now REFUSES. The bootstrap problem is real and is answered by
`BBX_ALLOW_UNMEASURED_HEADROOM=1` — awkward to type, impossible to set by accident, and it
announces in the output that the deploy is proceeding blind. Proceeding without a measurement is
now a decision somebody made rather than the default nobody saw.)*

## A REFUSAL THE CLIENT IGNORES IS NOT A REFUSAL (ratified 2026-08-05)

**"A refusal the client ignores is not a refusal. A control that returns a status the deployed
client does not honour has no effect, however correct it is server-side. Verify what the client
does with your refusal, not that you sent one."**

*(Origin: Brief 33 Fix C. TWO independent mitigations for runaway polling existed and neither had
ever fired. The Brief 33 Fix A runaway-poll ceiling answered 429. An expired magic token answered
401. Both are unimpeachable server-side, and the shipped dashboard does `r.ok ? r.json() : null`
and reschedules on null — so it read both as "no data, try again" and polled on forever. Two
correct refusals, zero effect, for weeks.*

*The kill that worked was not a better status. It was finding the one thing the deployed client
already honours — `terminal: true` on a 200 — and delivering the stop in that dialect. The client
in the field is the one that has to act; a status is a proposal, not an outcome.)*


## DELETING A CREDENTIAL VERSUS DELETING A RECORD (ratified 2026-08-05)

**"Deleting a credential removes the ability to open a door. Deleting a record removes the proof
there was a room."**

*(Origin: Brief 57. A coordinator credential exists for the duration of a live event and not one
second longer — so view sessions and magic tokens die the moment an event reaches any terminal
state. But the custody chain, the audit rows, the delivery records, the closure report and the
event itself are permanent at any age, because they are the evidence of what happened and who was
reached.*

*The line is not obvious from the table alone, and getting it wrong is silent in both directions.
`enrollment_codes` LOOKS like spent credentials and is a RECORD: a redemption row is the only
evidence of who was enrolled and by whom, which is exactly what an institutional audit asks for.
Its usability is swept at redemption instead — an atomic claim guarded on `revoked = 0 AND
usedCount < maxUses AND expiresAt > now` — so the code cannot authorise anything while its row
survives forever. A connected `line_pairings` row is the same shape and the first version of that
sweep would have deleted it, because a connected pairing is expired too.*

*The test enumerates the evidence tables and fails if any cleanup statement names one. Sweep the
ABILITY to use. Keep the record.)*


## WHEN CLASSIFYING DATA, THE DEFAULT IS RECORD (ratified 2026-08-05)

**"When classifying data as credential or record, the default is RECORD. Both errors are not
equal: keeping a dead credential costs a row, deleting a record destroys proof that cannot be
recreated. Twice this week the line was drawn toward deletion — enrollment codes, then
line_pairings, where a connected pairing is expired by construction and the sweep would have
destroyed the record of who connected a LINE contact and when."**

*Enforced, not merely written: `purgeExpiredCredentials` carries a JUSTIFICATIONS table, one entry
per swept table, and a guard fails any sweep that adds a table without a written reason why it is
a credential and not a record.*

## EVERY CLIENT-SIDE LOOP DECLARES THREE THINGS (ratified 2026-08-05)

**"Every client-side loop declares three things: a stop condition evaluated on every outcome, a
delay, and an attempt ceiling. A recursion that fires again immediately on failure is bounded only
by network latency — roughly 18 requests per second, per tab, indefinitely. Four instances in one
file."**

*(Origin: Brief 58. `pumpFetch` in the coordinator dashboard did
`if(buf){ nextSeq++; } pumpFetch();` — advancing only on success and recursing unconditionally. On
any non-OK response it asked again with NO delay, bounded solely by round-trip time. Measured:
66,500 requests/hour, flat, for eight hours; 1,038,439 in one day.*

*Four instances in `page.ts` alone, found across three separate audits: Brief 33 Fix A fixed the
bare `setInterval`; Fix C fixed the `/state` poll and the SSE reconnect; this was sitting between
them the whole time. A fifth shape was found in the same sweep — the WebSocket and SSE ladders
reset their attempt counter on a successful open, so a connection that opens and closes
immediately can never accumulate toward its ceiling. Bounded per burst is not bounded; they now
carry a lifetime budget as well.)*

## status:success IS NOT HTTP 200 (ratified 2026-08-05)

**"status:success in Cloudflare analytics means the Worker ran and returned. It does not mean
HTTP 200. A 401 is a successful invocation."**

*(Origin: Brief 58. I read "zero errors" in `workersInvocationsAdaptive` as "every request
returned 200", and reasoned from there to "what route serves an unauthenticated caller at 18
requests a second?" — a question with no answer, which sent the investigation toward batch jobs
and self-fetches. The route in question was returning 401 to every single one of those requests.*

*The number that DID settle it was `subrequests`: a Worker self-fetching 66,000 times an hour
produces 66,000 subrequests, and it produced zero. That refuted the batch-job hypothesis in one
figure and pointed straight back at an external client.)*

## A COLUMN THAT RECORDS A FACT MUST NOT ALSO GATE A BEHAVIOUR (ratified 2026-08-06)

**"A column that records a fact must not also gate a behaviour. `coordinatorClaimedAt` recorded
that coordination was taken AND gated the cascade halt, so clearing it to escalate the confirmer
tier restarted notification on an event that had a coordinator. Where a state change means two
things, it needs two columns."**

*(Origin: a live incident. The 180s coordinator-path-failure branch cleared `coordinatorClaimedAt`
so a guardian could claim — a correct intention — and the cascade halt is
`WHERE coordinatorClaimedAt IS NULL`. The secondary contact was notified that nobody had
responded, five minutes after someone had, and was offered TAKE COORDINATION on a coordinated
event. The "never offer coordination on a claimed event" guard was present and correct; it was
reading a column that had just been falsified to mean something else.)*

## A STATE MUST NOT INSTRUCT AN ACTION IT HAS REMOVED THE MEANS TO PERFORM (ratified 2026-08-06)

**"The design said ask again and made it impossible. That is the shape to watch for: a state that
instructs an action it has removed the means to perform."**

*(Origin: the same incident. The server cleared the survivor's closure assent so that she "must
request a SECOND time" — its own comment — while the client's `awaiting` view had both blocked the
press handler and replaced the control with a message. Two reasonable local decisions composing
into a survivor locked inside her own alert for eleven minutes. Neither half is wrong on its own,
which is why this needs naming rather than fixing once.)*

## A PAGE HAS ONE RENDERING SYSTEM (ratified 2026-08-06)

**"A page has one rendering system. Where a server render and a client poll both write the same
page, every value the server emits is emitted by a function the poll also calls. Two systems means
the values only one of them updates are photographs, and a coordinator deciding whether to send
help is reading them."**

*(Origin: the coordinator dashboard had a server render for everything and a client poll that
updated seven values. Three separate incidents came out of the gap — "No camera feed" beside 53
uploaded video chunks, "NO AUDIO RECEIVED" beside a live scrolling transcript, and a secondary
contact offered TAKE COORDINATION on an event that had had a coordinator for five minutes. Each
was fixed individually; the third proved that fixing them individually was the wrong shape of
response.*

*Enforced by `dashboard-one-renderer.guard.test.ts`: every id the server emits must be written by
a function `render(st)` calls, and the failure names the specific element — "the dashboard is
stale" is not actionable, "cascadeReach is emitted by SSR and never updated" is.)*

## FEEDBACK MUST BE DISTINGUISHABLE FROM SILENCE (ratified 2026-08-06)

**"Feedback must be distinguishable from silence. A message swapped for a near-identical message
in the same size and opacity is not feedback."**

*(Origin: a survivor pressed "end alert" and nothing happened. The fix swapped "Press and hold
until the ring completes to request closure." for "Press and hold until the ring completes." — the
same 11px, the same 40% opacity — and she reported being unable to close her alert a second time,
on the build that was supposed to fix it. Compounding it, the button carried `disabled` whenever a
request was in flight, so some presses were never delivered to any handler at all.*

*The answer was not a better sentence. It was making the press decision a TOTAL function —
`outcomeForRelease` returns either a submission or a message, for every state — so the caller is
obliged to render something, and an exhaustive test asserts no combination of inputs yields
silence.)*
