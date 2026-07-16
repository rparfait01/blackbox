# BLACK BOX — Brief 15: trigger regressed by the single-active fix (P0 — core function down)

After b23e8f8 / Worker 30883a0d (single-active-session), the core trigger is DEAD in both modes and
check-in broke with it:
- Hidden: the facade hold fires as a button (pointer fix holds) but NO event is created.
- Visible: "activate alert" does nothing.
- Check-in ("I'm OK") does nothing.

Three user-initiated actions broke at the same deploy → a shared server path. This is a regression
from the last fix, not a new area. **P0: restore the trigger before anything else.**

## Why the last "proof" didn't catch it (fix the bar, not just the bug)
The guard was proven by a row count — "5 triggers → 1 event (1 create + 4 resumed)" — using a throwaway
userHash with no contact. That verified a row exists; it never verified a real trigger surfaces a LIVE
event and fires the cascade. The acceptance bar for this fix is a live event on the dashboard from a
real trigger, not an insert count.

## Diagnose first — treat b23e8f8 as the suspect; name the actual cause
Pull the worker log for one real trigger and read the server response. Determine which:
1. **resolveSingleActive resumes a CLOSED event.** If the match (userId OR userHash) isn't filtered to
   open/active status, then right after the 33-event sweep it matches a recently-closed event and
   "resumes" a dead id — button fires, nothing surfaces. (Most likely.)
2. **The unique index rejects the first insert.** `idx_one_active_event_per_user` /
   `_per_userhash` — check it isn't blocking the legitimate first open event for a logged-in user who
   has BOTH a userId and a userHash (two index paths, one insert), or colliding on a stale row.
3. **Shared-helper throw.** resolveSingleActive (or a shared account-state resolver) errors for the
   real logged-in case and the create path swallows it.
Then determine check-in separately: does it regress from the SAME deploy (shares the endpoint/helper),
or is it the pre-existing Brief 17 §1 break resurfacing? Name it — don't assume.

## Fix — Module 4 create/resolve path only
- resolveSingleActive must match/resume ONLY events that are actually open/active. If none are open, it
  MUST create a new live event. A closed event is never resumable.
- The single-active guard must ALLOW creating the first open event (one open row is legal). Verify it
  is not rejecting the legitimate insert; if userId+userHash produce two index checks, they must not
  conflict on a single new event.
- The path must surface a LIVE event (dashboard push + cascade), not just insert a row.
- Restore check-in to a working dormant-only heartbeat. If it shares the regressed helper, the same fix
  restores it — verify it independently, not by inference.

Do not touch: capture, notification content, custody, facade visuals, Visible UI layout, E0 idempotency,
E4 disposition. Create/resolve logic and check-in delivery only.

## Prove END TO END on a real device — a live event, not a row count
- `[L]` Hidden: hold-trigger → a LIVE event appears (dashboard shows it / cascade fires) → re-trigger →
  still exactly one → close → account fully dormant, no fallback.
- `[L]` Visible: activate alert → same live-event proof.
- `[L]` Check-in → recipient receives status+time+location, user sees delivered confirmation.
- `[L]` Single-active still holds: a second trigger during a live event creates no second event.
- Both Present modes; §0a byte-identical still holds in Hidden.
- Proof is the live event surfacing from a real trigger — screenshot/log the event on the dashboard,
  not a SELECT count.

Commit naming the actual cause. No `known-good` tag until Royce confirms all three work on the phone.
