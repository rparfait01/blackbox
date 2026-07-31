# BLACK BOX — FIX BRIEF 18 — Visible trigger + Check-in: the last two dead controls

**Floor:** current known-good. Do not regress. Hidden trigger and one-way user-initiated closure WORK now — do not touch them.
**Mode:** deployed production, both Present modes.
**Why this brief exists:** Briefs 15 and 17 declared these fixed via inference / row-counts. They are still dead.
This brief bans that. Diagnosis = a captured console+network artifact. Proof = a live event / real delivery
you can screenshot. No "tests pass." No "restored via shared helper." Prove each independently or it is not done.

---

## THE DEDUCTION THAT SCOPES THIS (do not re-diagnose server create/resolve)

Hidden trigger surfaces a live event. Visible trigger does not. Both are supposed to hit the SAME server
create/resolve path (Brief 15). Therefore the server create path is proven working by the Hidden case, and the
Visible break is **client-side** — the instrument-screen `activate` handler is not reaching that working call.
Do NOT reopen `resolveSingleActive` / the single-active index for the Visible bug. Look at the client.

Check-in is a separate, delivery-path break — it shares nothing with the trigger fix and was never proven on
its own. Treat it independently.

---

## SECTION A — Visible-screen push-button trigger  `[A→L]`  *(client-side)*

**Diagnose first — capture the artifact, don't guess.** On the DEPLOYED app, Visible mode, open the console +
network tab, do one real HOLD-to-activate, and record all four:
1. Does the hold handler fire at all? (log at the top of `startActivate`/`activate`.)
2. Does it throw before the fetch? (any red console error.)
3. Does a network request actually go out? (network tab — request present or not.)
4. If it goes out: what URL + method, and what status/body comes back?

The commit note MUST state the answers to all four. That is the diagnosis of record.

**Then fix to the working path.** Whatever Hidden's hold does to surface a live event, Visible's hold must do
the identical server call. Most likely one of: handler was unbound/rebound during the 15/16 settings rework;
an early `return` (e.g. a stale `state.activated` or mode guard) kills it before the fetch; or it calls a
renamed/old endpoint. Fix the divergence so Visible and Hidden reach the same create call. Do not rebuild the
server side.

**Acceptance:**
- `[A]` commit note names which of the four failed and the exact cause.
- `[L]` Visible → real hold-to-activate on the deployed app → a LIVE event appears on the dashboard AND the
  cascade fires. Screenshot the dashboard event. A row insert is NOT proof.
- `[L]` Hidden trigger still works (no regression); single-active still holds (2nd trigger = no 2nd event).

---

## SECTION B — Check-in ("I'm OK")  `[A→L]`  *(delivery path)*

**Diagnose first — capture the artifact.** On the DEPLOYED app, dormant, open console + network, tap check-in,
record:
1. Does the tap handler fire?
2. Does a request go out, to what URL, with what body (does it include the captured location fix)?
3. What status/body comes back?
4. On the server side: does the recipient's channel (guardian, per Brief 17 §1) actually get a send logged,
   or does it dead-end before dispatch?

Commit note states all four.

**Then fix the delivery path.** Check-in must: capture location on tap (no checkbox — single button, Brief 17
§1), POST status+timestamp+location, dispatch to the guardian on a real channel (email/SMS/LINE), and return a
delivered confirmation to the user. It stays dormant-only — no capture session, no event, no coordinator.
No silent success: if dispatch fails, the user sees a failure, not a fake "delivered."

**Acceptance:**
- `[A]` commit note names where it was dead-ending (handler / request / server dispatch).
- `[L]` real tap on deployed app → guardian actually RECEIVES status + time + location (confirm on the
  receiving device/inbox, not a send-count) → user sees a real delivered confirmation.
- `[L]` fires only when dormant; nothing else changes.

---

## OPEN QUESTION FOR ROYCE — not built until you call it

You said end-session now works "one way, user-initiated only." Per Brief 16 §2 (E1) closure is dual-consent,
order-independent, **either** side may initiate. One-way-user-only means the coordinator-initiated and the
reciprocal-confirm paths are still down — a regression against E1 — OR it's a deliberate v0 simplification.
I did not scope it into this brief. Tell me: bug to fix next, or intended for now?

---

## DEFINITION OF DONE
A and B each: captured-artifact diagnosis in the commit note; passes on the DEPLOYED app; live-event /
real-receipt screenshot (not a count / not inference); Hidden + closure unregressed; check added to the
acceptance suite; committed; deployed. Phone sign-off before any known-good tag.
