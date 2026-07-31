# BRIEF — EVIDENCE REVIEW = THE FULL DASHBOARD (not a bare player)

**Encryption is armed and captures now open — good. But the review screen is a lone video element with two
stats. It must be the full evidence dashboard (Royce's design). Plus two smaller fixes. Root cause, not patches.**

Standing constraints apply. §0a Hidden byte-identical. Trigger/capture/classifier untouched. Both halves
currency-asserted. Prove [L] on real device.

---

## §1 — CHECK-IN CONTACT: remove the "optional/selectable" language
- `[A]` The check-in language still presents as optional/selectable. Fix: it is simply the **check-in contact**,
  shown with a checkmark — the primary contact IS the check-in contact. No "optional," no fake selector.
- `[A]` Confirm check-in routes to the primary contact.

## §2 — THE EVIDENCE DASHBOARD (the main fix)
The review screen currently shows only a video player + "segments played" + "matches recorded." That is not the
dashboard. Build the full evidence dashboard per the existing design (BRIEF_survivor_evidence_review.md layout):

- `[A]` **Video/scene pane** — the decrypted video, playing.
- `[A]` **Audio** — waveform + transport (play/pause/reset/scrub), synced to playback. Audio is presented, not
  just "video or nothing."
- `[A]` **Selected capture** — the chosen capture with auto date/time (from event), and the calm note.
- `[A]` **Summary panel** — People / Aggressor(s) / Victim(s) / Tone / Weapon(s) / Danger(s), populated from the
  EVENT RECORD (classifier output), read-only. Only the survivor may add a real name. Empty fields stay empty.
- `[A]` **Transcript** — rolling, synced to playback.
- `[A]` **Location** — start location + traveling Y/N + map pin from coordinates.
- `[A]` All panels present together as ONE dashboard — not a bare video with two stats.
- `[A]` A capture may be video+audio, audio-only, or (covert) audio-only — the dashboard renders whatever the
  capture contains. If audio-only, show the audio/waveform + transcript + summary + location; don't show a dead
  black video box as the whole screen.

## §3 — RESPONSIVE RENDERING (mobile + desktop)
- `[A]` **Mobile-friendly** layout — panels stack cleanly, video sized to the phone, controls tappable.
- `[A]` **Desktop / larger display** — best rendering for the available space: multi-pane layout (video + audio +
  summary + transcript + map arranged like the design), larger video.
- `[A]` Rendering adapts to the display — small screen stacks, large screen uses the full dashboard layout.
- `[A]` Video is playable inline on both; no download (Evidence Review is review-only per the locked model).

## §4 — GUARDS
- `[A]` §0a: dashboard + entry on Visible side only, never the Hidden facade.
- `[A]` Decrypt on device only; server never sees plaintext.
- `[A]` Summary is read-only from the event record; only survivor-added names persist (sealed, never alters
  signed evidence).
- `[A]` Close Dashboard = quick-exit, clears decrypted view instantly.

## ACCEPTANCE (real device + desktop)
- `[L]` Check-in shows as the check-in contact with a checkmark, not optional; routes to primary.
- `[L]` Opening a capture shows the FULL dashboard (video/audio/summary/transcript/location), not a bare player.
- `[L]` Audio-only capture renders audio+transcript+summary+location, not a dead black box.
- `[L]` Mobile: panels stack, video fits, controls work. Desktop: full multi-pane layout, larger video.
- `[L]` Summary populates from event record, read-only; survivor can add a name.
- `[A]` §0a byte-identical; decrypt on device; Close Dashboard clears view.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Real-device (mobile) AND desktop proof. Confirm the full dashboard renders, not
a bare player, and adapts to display size. Deployed hash, both halves asserted.
