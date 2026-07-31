# BLACK BOX — Fix Brief 8: Settings & UI (revised)

Front-end / settings work, flyable independently of the closure logic (Brief 9). Device-verify on
a clean build.

(The closure status report that was once here moved to Brief 9 — it's the artifact the coordinator
reviews in the closure window, so it belongs with the closure flow.)

## P0 — Settings is inaccessible during an active alert

- The settings entry point (icon) is NOT selectable while an alert session is active. Tapping it
  does nothing, or shows "locked during an active alert."
- This guards the active-alert lockdown — no editing contacts, guardian, code, or guardian-on/off
  mid-event.
- Add a regression test so this stays fixed. (It has regressed before; pin it.)

## P1 — Add-contact UI in Settings (contact tabs)

- Settings shows the support roles as tabs: three Contact slots (primary, secondary, tertiary)
  plus one Guardian slot.
- A FILLED slot's tab is selectable — tap to view / edit / remove that contact.
- An EMPTY slot's tab shows a "+" so the user can add a contact to it. Adding persists
  server-side.
- [NAMING — confirm: the founder wrote "guardian 1/2/3." The model is three Contacts + one
  Guardian (the single zero-fail failsafe). Built as 3 contacts + 1 guardian to preserve that
  distinction. If multiple guardians are intended, that changes the failsafe model — confirm
  before shipping.]

## P1 — Audio playback shows ERROR

Audio is captured and uploaded, but the dashboard play button shows "ERROR" and will not play.

- Diagnose: R2 fetch (signed URL / range request / MIME type) versus a codec or container the
  browser can't decode.
- Fix so the coordinator can play captured audio directly from the dashboard. State which cause it
  was. (The camera "no feed" is likely the same relay/render family — note any overlap, but video
  is NOT a v0 dependency; do not scope a camera fix into v0.)

## P1 — Move the map to the top of the coordinator view

- Reorder the coordinator dashboard so the live location map sits at the top.
- (Prior hierarchy was origin → situation → camera → transcript; the map now leads.)

## Acceptance criteria (device-verified, clean relaunch)

1. During an active alert, the settings icon is not selectable (regression-guarded).
2. In Settings, filled contact slots are selectable and empty slots show "+" to add; adding
   persists and survives a reopen.
3. Captured audio plays from the coordinator dashboard with no ERROR.
4. The live map renders at the top of the coordinator view.
