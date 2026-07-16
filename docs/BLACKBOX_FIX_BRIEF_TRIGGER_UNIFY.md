# BLACK BOX — FIX BRIEF (assign next free git number — do NOT reuse 20/21) — Unify triggers to tap-to-activate

**PRODUCTION. LIVE PILOT USER. ZERO REGRESSION. This is the hard constraint above all else.**
**Scope:** change ONLY the two client trigger dispatches (Visible activate, Hidden facade). Nothing else.
**Proof:** live event from a real tap on the phone, both modes. Not a row count, not "tests pass."

---

## DO NOT TOUCH (audit marked these PASS — confirm they still work, then leave them alone)
Server create/resolve (`resolveSingleActive`, single-active per-account), capture + location, closure
(dual-consent, Brief 16/20), check-in (Brief 19), live-alert lock (Brief 20), currency (Brief 21),
notification/cascade, custody, the §0a byte-identical Hidden facade. If Claude Code sees one of these working,
it moves on — no "improvements," no refactors, no touching adjacent code.

---

## §1 — VISIBLE: tap must always fire  `[A→L]`  *(client only)*

Visible already taps. The only failure is the `!armable` early-return gate — which just failed on an account
that check-in delivered to, proving `armable`'s predicate disagrees with the recipient the system can actually
reach.

**Fix:** remove the blocking `!armable` early-return. The Visible tap ALWAYS creates the event — same
unconditional dispatch Hidden uses. A missing/undeliverable recipient is SURFACED to the user (Visible only,
never a tell in Hidden), never a silent refusal. If an armable signal is wanted, it's a non-blocking notice, not
a gate. Do not touch the server create path — Hidden proves it works; this is the client early-return only.

**Acceptance:**
- `[L]` Visible tap on the phone → LIVE event on dashboard + cascade. Screenshot the event.
- `[L]` Visible tap on an account with NO deliverable recipient → still creates the event, surfaces
  "no recipient" — no silent no-op.

---

## §2 — HIDDEN: press-and-hold → tap-to-activate  `[A→L]`  *(client only)*

Replace the press-and-hold gesture with a tap on the facade. This removes the iOS long-press/pointer-capture
fragility behind the "Hidden failed" reports. Same trigger dispatch the hold currently calls — swap the gesture,
keep the dispatch. Facade stays **byte-identical** (§0a): no new visible element, no indicator, no tell.

**DECISION REQUIRED (Royce) — single-tap vs double-tap:**
A bare single tap on the facade risks accidental activation (cover use / pocket) → false cascade. Default in
this brief is **[ROYCE: single-tap | double-tap]**. Double-tap keeps full reliability, stays covert, and avoids
accidental fires. Implement the chosen one; do not add any visible affordance either way.

**Acceptance:**
- `[L]` Hidden [tap/double-tap] on the phone (iOS Safari AND Android Chrome) → LIVE event on dashboard +
  cascade + location fix. Screenshot the event.
- `[L]` Facade byte-identical before/after trigger — no tell in Hidden (§0a guard passes).
- `[L]` No accidental fire from ordinary facade interaction (verify on the chosen gesture).

---

## §3 — CHECK-IN: no change  `[A]`
Check-in already taps and works (Brief 19). Regression check only — confirm it still delivers to the designated
recipient with honest confirmation. Do not modify it.

---

## ZERO-REGRESSION GUARD — re-verify ALL before "done"
Hidden create, Visible create, single-active (one event per trigger, per-account), closure (dual-consent),
check-in (19), live-alert lock (20), currency (21), capture+location, §0a facade byte-identical. Any of these
breaking = the change is a failure regardless of what else it does. Full acceptance suite green before any tag.

## DEFINITION OF DONE
Both triggers fire on tap, proven live on the phone in both modes on both platforms; every protected path
re-verified; new rows added to the acceptance suite (Visible-no-gate, Hidden-tap iOS + Android); committed
naming exactly the two dispatches changed. Deploy via `pnpm deploy` (Brief 21 flow). Royce phone sign-off
before `known-good` tag. This closes triggers; closures next, then the two evidence/data blocks.
```
```
