# BLACK BOX — Brief 15 Amendment: real cause is touch handling, not mount/scope

Diagnosis correction. Claude Code confirmed both gestures ARE wired into the facade, so the
original "handlers not mounted in Hidden" hypothesis is wrong. The on-device read is the tell:
the breathing orb takes a press like a static image, not a button. That's touch handling, and it's
Hidden-specific because the Visible view activates on a plain tap (onClick) that never hits this path.

## Gate 0 — resolve BEFORE any code: which branch does prod serve?
master is at 2026-06-13 and does NOT contain the closure-gesture commit (ec4c807, Brief 15 §E2);
the fix branch is ahead. If the app being tested builds from master, the Hidden closure gesture
isn't deployed at all — that alone is the "can't end alert in Hidden" half, and there is nothing to
fix in code, only to ship.
- Confirm the branch prod actually builds from.
- If it's master: deploy/merge the fix branch to prod, then retest closure in Hidden BEFORE touching
  anything. Do not debug a feature that isn't shipped.

## The trigger bug (Hidden-only, real)
The hold never completes on a phone because the press is treated as a static target, not a captured
button hold. Two mechanisms, both likely in play:
- No `touch-action: none` on the gesture target → the mobile browser claims the press as a scroll/pan
  and fires `pointercancel`, silently aborting the hold. (A desktop mouse held still never reproduces
  this — why it passed a dev check.)
- The finger may be landing on a visual layer (the animated orb / an image) that isn't the element
  carrying the handlers, or that intercepts the event before it reaches them.

## Authorized fix — now IN scope (this and nothing else)
Editing `useActivationHold` and the facade gesture target is authorized — it IS the bug. Limit
strictly to pointer/touch handling:
- Add `touch-action: none` to the gesture target.
- `setPointerCapture(e.pointerId)` on pointerdown; `releasePointerCapture` on pointerup. Do not abort
  the hold on `pointerleave`/`pointercancel` once the pointer is captured.
- Make sure the element under the finger (the visible orb) is the one carrying the handlers. If a
  child/overlay/image sits on top, either move the handlers to that top layer or set it
  `pointer-events: none` so the press reaches the handler. This is the "acts like an image" fix.

Do not touch: closure semantics, the Visible view, lifecycle / notification / custody. An innocent
short tap must still do nothing — only the deliberate ≥1.8s hold activates. Facade behavior unchanged.

## If closure still fails after Gate 0
Only if closure is confirmed deployed and still fails on-device in Hidden: it's the same pointer-
capture bug in ClosureControl's hold gesture — apply the identical touch-handling fix there. If closure
works, leave ClosureControl alone. Do not pre-emptively refactor it.

## Invariant (unchanged): §0a byte-identical
Everything above is invisible plumbing (event handling + CSS). No indicator, no visual change in
Hidden — dormant and active stay identical.

## Prove on a real phone (desktop cannot reproduce this)
- `[L]` Hidden/dormant → press-and-hold the orb → activation fires; server confirms.
- `[L]` Hidden → quick taps → nothing (no false trigger).
- `[L]` Hidden (after Gate 0) → closure hold ≥3s = SAT, release <3s = UNSAT; server confirms.
- `[A]` Visible → trigger + closure unchanged.

Commit naming the actual cause. No `known-good` tag without phone sign-off.
