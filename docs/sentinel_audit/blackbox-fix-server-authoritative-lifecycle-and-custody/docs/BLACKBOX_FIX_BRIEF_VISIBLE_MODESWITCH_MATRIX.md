# BLACK BOX — FIX BRIEF (assign next free git number) — Visible no-op after mode switch: CC drives the whole matrix, diagnoses, fixes

**PRODUCTION. LIVE PILOT. P0. Claude Code runs the reproduction ITSELF on the deployed app — do NOT hand back to
Royce for another phone cycle.** Use D1 + a live `/v1/me` tail + direct prod requests to reach every ordering and
read the state delta at each step. Confirm the cause on captured evidence, then fix, then prove.
**Zero regression** to Hidden trigger (Brief 27 cycle now works), check-in, closure, lock, currency, §0a facade.
**Do NOT touch `triggerActivation`'s dedup guards.** Brief 27 fixed clean-slate-on-close; Hidden cycles clean.

---

## WHAT IS KNOWN vs UNKNOWN (do not re-derive; resolve the unknown)
KNOWN, on Royce's f21b8ed test:
- Hidden → close+confirm, back-to-back ×3, one login, standard Safari: **all fire.** Brief 27 works.
- Then 2 check-ins: fire.
- Then Visible in the same session: **no-op** (gesture recognized, permissions requested, then returns without
  creating an event).

UNKNOWN and MUST be resolved by CC, not by assumption:
- Whether Visible fails **on its own** (broken independent of Hidden), or **only after Hidden/check-in in the
  same session** (a mode-switch state issue). Every observed Visible attempt so far followed Hidden — the two
  are confounded. **Resolve this first.**

## §1 — CC RUNS THE FULL ORDERING MATRIX ITSELF (deployed app, one session per row, live `/v1/me` + D1)
For each row: fresh login, then the sequence, capturing after EACH trigger whether `POST /v1/events` fired, its
status/body, and the `/v1/me` activeEvent + session state read at that moment:
1. **Visible FIRST**, fresh login → Visible trigger. (Does Visible work with zero prior Hidden/check-in?)
2. Visible → close+confirm → Visible → close+confirm ×3 (Visible-only cycle).
3. Hidden → close+confirm → Visible (the reported failing path).
4. Visible → close+confirm → Hidden (inverse).
5. Check-in → Visible (does a check-in alone poison Visible?).
6. Hidden → check-in → Visible (exact reported sequence).

The matrix isolates it deterministically:
- If **row 1/2 fail** → Visible is broken on its own; fix is the Visible dispatch path, independent of mode.
- If **row 1/2 pass but 3/6 fail** → it's a **mode-switch / residual-state** bug: switching to Visible after
  prior activity doesn't reconcile, so Visible reads stale active-state and bails. Likely cause: Brief 27's
  `reconcileToServerDormancy()` fires on close/foreground/load but **NOT on in-app mode switch**, so a
  Hidden→Visible switch within one session skips the reconcile and Visible sees stale state.
- Capture, on the failing Visible tap: does `POST /v1/events` fire? No POST = client bail (state/guard); POST +
  error = server. Name it.

State the resolved cause, with the matrix results + the `/v1/me`/POST evidence, in the commit.

## §2 — FIX (to the matrix result)
- **If mode-switch residual state (most likely):** run the same server-authoritative reconcile Brief 27 uses
  (`reconcileToServerDormancy()` → read `/v1/me`, clear stale active-state in place) **on mode switch** as well
  as on close/foreground/load. Switching modes must never leave Visible reading Hidden's residual state. Reuse
  Brief 27's reconcile — do not fork new logic.
- **If Visible broken on its own:** fix the Visible dispatch path (it must reach the same `triggerActivation`
  server call Hidden reaches — Hidden proves the create path). Do not touch Hidden or the dedup guards.
- Safety guard intact: only clear/reconcile when the server confirms dormant; a genuinely open event resumes,
  not duplicated.

## §3 — ACCEPTANCE (CC proves ALL on the deployed app, one login each, no re-login/kill/incognito)
- `[A]` commit names the resolved cause with the row-by-row matrix + POST/`/v1/me` evidence.
- `[L]` Visible-first works; Visible-only cycle ×3 works.
- `[L]` Hidden→Visible and Visible→Hidden switches both fire, repeatedly, one session.
- `[L]` Hidden→check-in→Visible (the exact reported failure) fires.
- `[L]` Hidden cycle (Brief 27) still clean; check-in, closure, lock, currency unregressed; §0a intact.
- Add the full ordering matrix (all 6 rows) to the acceptance suite so any mode-order regression is caught.

## DEFINITION OF DONE
Every trigger fires in every ordering within a single login — Visible-first, Visible-only, both switch
directions, and after check-in — proven by CC on the deployed app with captured `/v1/me`/POST evidence per step.
Matrix added to the suite. Committed; deployed via `pnpm deploy`; `version.json` asserts the new build. Then
Royce does ONE confirmation pass on the phone before `known-good` — not another diagnostic cycle.
