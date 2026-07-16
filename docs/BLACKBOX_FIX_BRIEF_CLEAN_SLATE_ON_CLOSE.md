# BLACK BOX — FIX BRIEF (assign next free git number) — Event closure must clean the slate (session-state, not trigger)

**PRODUCTION. LIVE PILOT. P0. Diagnose → confirm → fix in ONE pass. Do not hand back for more phone taps —
capture the evidence yourself off the deployed app and watch D1/session live.**
**Zero regression** to trigger dispatch, check-in, closure, lock, currency, §0a facade.
**This is NOT a trigger bug. Stop touching triggerActivation's dedup guards — Briefs 25/26 already did that and
it wasn't the cause.**

---

## GROUND TRUTH (from the pilot, precise — do not re-derive, confirm it)
Pilot: dominick.parfait@icloud.com. Established by isolation testing on the deployed app:
- **Both triggers work on a FRESH login** (Hidden double-tap and Visible tap each fire — first event of a
  session).
- **After one event fires and is closed, the NEXT trigger no-ops** — in either mode. The gesture is recognized,
  permissions are requested, the location watch starts, then it silently returns without creating an event.
- **The ONLY thing that restores triggering is a fresh login.** Not closing Safari, not incognito — those merely
  force a re-login. Incognito does NOT fix it; incognito forces logout-on-close, and the subsequent **login** is
  the reset.
- **Check-in works throughout**, across any number of triggers/closes, with no re-login — because check-in does
  not depend on event/session active-state.

**Conclusion the evidence forces:** the poisoned state is **session/auth state (or session-derived
active-state)** that a fired event corrupts or staleness, that persists across triggers, and that is only rebuilt
by a new login. Every prior symptom ("Visible dead after Hidden close", "double-tap no-ops", mode flip-flop) is
downstream of this one defect.

---

## §1 — DIAGNOSE (capture the delta; name it in the commit)
On the deployed app, one session, Network open:
1. Fresh login → record the trigger's session/auth reconcile call and its response (`getSession` / `/v1/me` /
   whatever `triggerActivation` reads — the delivery/active-state read). Note the exact shape: session token
   validity, `activeEvent` value.
2. Trigger → close + fully confirm (event leaves the dashboard; confirm in D1 it is closed).
3. **Without re-logging in**, attempt the next trigger. Capture the SAME session/auth reconcile call's response
   now.
4. **Compare step 1 vs step 3.** The delta is the bug. Expected findings (identify which):
   - (a) the session read returns a **stale `activeEvent`** (client believes an event is still active though D1
     shows closed) → the session's active-event binding is written and never refreshed in place after closure;
   - (b) the session token is **expired/invalid/401** and the trigger silently bails → the token isn't refreshed
     in place and only login re-mints it;
   - (c) a **client-cached session object** (IndexedDB/localStorage/in-memory store) is read back as active and
     is never cleared on close.
5. Confirm check-in reads a DIFFERENT path (why it's immune) — this validates the diagnosis.

State which of (a)/(b)/(c) it is, on the captured evidence, before writing the fix.

## §2 — FIX: closure cleans the slate (server-authoritative)
**Principle: every event closure returns the client to a genuinely dormant state in place — identical to a fresh
login — with no teardown, no re-login, no Safari kill required.**
- On closure completing server-side, the client **reconciles session + active-state against server truth and
  clears** whatever the diagnosis named: stale `activeEvent` binding cleared; token refreshed/re-validated in
  place (never leave the trigger reading an expired session); any cached session object (IndexedDB/localStorage/
  store) reset to dormant.
- The reset is **server-authoritative** — the client re-reads `/v1/me` (activeEvent = none, session valid) and
  sets local state from that, not from stale client memory.
- **Conservative safety guard (unchanged intent):** never drop a genuinely live recording. If the server still
  shows the event open (e.g., dual-consent not actually completed), correctly resume it — that is single-active
  working, not this bug. This fix only cleans state once the server confirms closure.
- Do NOT modify `triggerActivation`'s dedup logic further; the trigger is correct. Fix the **post-closure session/
  active-state teardown** so the guards read a clean session.

## §3 — REGRESSION-PROOF THE CYCLE (the real acceptance)
Prove the full cycle on the deployed app, **one login, no re-login, no app kill, no incognito**:
- Hidden → double-tap → close+confirm → Hidden → double-tap → close+confirm … ×3, same page, rapid.
- Hidden → close+confirm → Visible → close+confirm → Hidden … ×3, mode-switch.
- Every trigger after every confirmed close fires, with NO re-login.
- Check-in still works interleaved.
Add this "trigger→close→trigger, single session, no re-login" cycle to the acceptance suite so it can never
silently regress.

## ACCEPTANCE
- `[A]` commit names the diagnosed state (a/b/c) with the captured session-read delta (fresh-login vs
  failing-second-trigger).
- `[L]` on deployed app, ONE login: the full both-orders cycle fires every time with no re-login/kill/incognito.
- `[L]` a genuinely still-open event (unconfirmed close) is correctly resumed, not duplicated (guard intact).
- `[L]` trigger dispatch, check-in, closure, lock, currency unregressed; §0a facade byte-identical.

## DEFINITION OF DONE
Event closure returns the client to a clean dormant state in place; triggering works indefinitely across
closures within a single login; cause named on evidence; cycle added to the acceptance suite; committed;
deployed via `pnpm deploy`. Phone sign-off (no re-login required) before `known-good`.
