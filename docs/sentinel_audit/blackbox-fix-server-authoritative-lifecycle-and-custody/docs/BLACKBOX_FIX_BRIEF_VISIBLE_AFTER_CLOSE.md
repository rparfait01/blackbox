# BLACK BOX — FIX BRIEF (assign next free git number) — Visible trigger dead after closing a Hidden event

**PRODUCTION. LIVE PILOT. P0.** Diagnose AND fix in one pass. Do not hand back for more testing — capture the
evidence yourself from the deployed app, fix on the evidence, prove it live.
**Zero regression** to Hidden trigger, closure, check-in, lock, currency, §0a facade.

---

## EXACT REPRODUCTION (from Royce, on the deployed current build — do not doubt it)
Same session, same device, current build (Hidden just fired, so build IS current):
1. Trigger Hidden → event created. ✅
2. Close the event → closed clean. ✅
3. Tap Visible → **does NOT trigger.** ❌

This rules out: stale build, server create path (Hidden used it), armable, orphan, cooldown, single-active
(the event was properly closed). The break is specifically **after a close** and it is Visible-side.

## LEADING CAUSE (validate, don't assume) — stale client active-state after close
The close cleared the event server-side, but the client's in-memory active-state did not reset, so Visible's
handler still believes an event is live and no-ops locally. This is the server-truth-vs-stale-client-state
failure this app has hit before: closure updates the server but the client "am I active" flag doesn't clear →
next trigger refused on the client. The tell is that Visible works UNTIL a Hidden event is closed, then dies —
that points at the close-reset, not at Visible's binding.

## §1 — DIAGNOSE (capture the artifact yourself, name it in the commit)
On the deployed app, reproduce steps 1–3 with console + Network open. On the step-3 Visible tap, record:
1. Does Visible's activate handler fire (log at the top)?
2. If it fires, does it hit a client-side active-state guard that returns early? Log the value of the client's
   active/event-state flag at that moment.
3. Does `POST /v1/events` fire? If yes, status + body.
4. After the step-2 close: did the client's active-state actually reset to idle, or is it stale? Compare client
   state vs server (`/v1/me` activeEvent — should be none).

Expected finding: server shows no active event, client still holds a stale active flag → Visible early-returns.
Confirm on the log before fixing.

## §2 — FIX (to the evidence)
- **If stale client state (expected):** closure must fully reset the client active-state to idle — server-
  authoritative. On close, the client re-reads server truth (`/v1/me` activeEvent = none) and clears the flag,
  so the next trigger (either mode) sees idle. Wire the reset on the client, not just server-side. Both Visible
  and Hidden must be triggerable immediately after any close, any order, any number of times.
- **If Visible handler never fires:** it's binding, not close-state — fix the Visible tap binding on this build.
- **If POST fires and server rejects:** the close didn't propagate server-side (event still open in D1); fix the
  close to actually resolve the event so the next create isn't blocked.

## §3 — REGRESSION-PROOF THE CYCLE (this is the real acceptance)
The failure is a state-machine gap across trigger→close→trigger. Prove the full cycle, both orders:
- Hidden trigger → close → Visible trigger → close → Hidden trigger → close (repeat).
- Visible trigger → close → Hidden trigger → close (repeat).
Every trigger after every close must fire. Add this trigger/close/re-trigger cycle to the acceptance suite so it
can never silently regress again.

## ACCEPTANCE
- `[A]` commit names the diagnosed cause with the logged client/server state at the failing tap.
- `[L]` on the deployed app: Hidden→close→Visible fires (the exact failing case). Screenshot the Visible event.
- `[L]` both trigger orders cycle cleanly ≥3 times each — no trigger dead after any close.
- `[L]` Hidden, closure, check-in, lock, currency unregressed; §0a facade byte-identical.

## DEFINITION OF DONE
The trigger→close→trigger cycle works indefinitely in both orders, proven live on the deployed app; cause named;
cycle added to the acceptance suite; committed; deployed via `pnpm deploy`. Phone sign-off before `known-good`.
