# BLACK BOX — Brief 15: Wire covert trigger + close in Hidden mode

**Floor:** current known-good (post Brief 16/17) — do not regress.
**Mode:** deployed app. Fix is Hidden-only; Visible must not change.

**Bug:** In Hidden (Stillpoint facade), the covert gesture does nothing — an alert can't be
triggered, and an active alert can't be closed. The gesture handlers aren't reachable while the
facade is rendered; only the Visible UI has them.

**Diagnose first.** Confirm where the trigger and closure gestures are bound and why they don't fire
under the facade (most likely: the handlers live on the Visible view and aren't mounted in Hidden).
Name the actual cause in the commit. Don't blind-patch.

**Fix — this and nothing else:**
- Wire the existing covert **trigger** gesture to the facade so activation works from Hidden. Use the
  intended gesture already in the code/spec — do not invent a new one.
- Wire the existing **closure** gesture to the facade, semantics unchanged: **hold ≥3s = SAT (clean);
  release <3s = UNSAT (duress).**
- Do not add any visible control. Do not let an ordinary breathing tap fire either gesture.
- Touch only the facade↔gesture wiring. Do not alter the Visible UI, the gesture logic itself, or any
  lifecycle / notification / custody code. If the fix needs a shared file, flag it before editing.

**Invariant that must hold (§0a covert-active):** in Hidden, the active screen stays byte-identical to
the dormant facade. This fix adds no indicator, DOM change, layout shift, haptic, sound, or tell in
Hidden — on trigger or on close, ever.

**Acceptance (deployed, on device):**
- `[L]` Hidden/dormant → covert trigger starts an alert; server confirms; facade unchanged.
- `[L]` Hidden/active → release <3s closes UNSAT (duress); hold ≥3s closes SAT (clean); server
  confirms both.
- `[L]` Hidden dormant vs active → no observable difference.
- `[A]` Visible → trigger and both closures still work, unchanged.

**Done:** passes on the deployed app in Hidden and Visible; previously-green stays green; committed.
No new `known-good` tag without Royce's phone sign-off.
