# BRIEF — SURVIVOR EVIDENCE REVIEW (her own captures, read-only, unlimited, protected)

**Gate: ENVELOPE_ENCRYPTION_ENABLED (same as report generation). Flag off → no review path exists.**
**Purely additive. Touches nothing existing. The verifier/report chapter's discipline applies: it's a leaf.**

Standing constraints apply. §0a byte-identical, safety floor untouched, both halves currency-asserted.
Prove [L] on the real surface.

---

## PRINCIPLE (settles every access question)
- The capture is HERS. Encrypted to her key. **She reviews it unlimited, on demand — no count, no cap, no
  rationing.** Rate-limiting a survivor's access to her own evidence is wrong.
- "It isn't ours" cuts toward MORE freedom, not less — we don't get to ration it.
- The limits that belong are PROTECTIVE (exposure, wellbeing), never restrictive (frequency).

## §1 — ACCESS MODEL
- Client-side decrypt with HER key, on-device. Server never sees plaintext — it only serves ciphertext +
  wrapped keys (Brief 26 custody).
- **Read-only by construction.** Evidence carries its capture-time commitment/signature (Brief 26); viewing
  never alters it, and integrity stays provable. No edit path to the evidence, ever.
- Renders: audio (play), video (play, where a camera capture exists), transcript/text (render). Whatever the
  capture contains, decrypted locally.
- `[A]` No decrypt happens server-side. No plaintext is ever written back to the server. Prove the server
  cannot read what she reviews.
- `[A]` Unlimited access — no view counter, no cap, no cooldown, no "you've viewed this N times" anywhere.

## §2 — PROTECTIVE VIEWING CONTROLS (this is where the care goes)
- **Deliberate open, never autoplay.** She chooses to open a specific capture; nothing plays or replays at her.
  No feed, no loop, no auto-advance.
- **Quick-exit.** A single obvious action instantly dismisses the decrypted view and returns to a neutral screen
  — same ethos as the covert facade. Someone walking in is not shown the evidence.
- **Auto-hide on inactivity / backgrounding.** The decrypted view clears itself if the app is backgrounded or
  after a short idle — plaintext is not left lingering on screen.
- **No content in notifications, previews, thumbnails, or share sheets.** A capture never surfaces outside the
  deliberate review view.
- `[A]` Decrypted plaintext exists only in memory during active viewing — never cached to disk, never persisted,
  cleared on exit/quick-exit/background.

## §3 — WELLBEING
- It isn't a movie, and she may be viewing the worst moment of her life. The screen is calm and deliberate, not
  frictionless-replay. A quiet "open" step, not an autoplaying feed.
- No gamification, no streaks, no counts, no nudges to review. She looks when she chooses.
- The screen never grades, comments on, or reacts to the content.

## §4 — WHAT THIS IS NOT
- `[A]` Not a coordinator/operator/org surface. Only the OWNING survivor can decrypt and view her captures.
  No role — coordinator, admin, operator — reaches this. (Coordinator live-operate under Brief 26 is a separate,
  event-scoped path; this is the survivor's own after-the-fact review.)
- `[A]` Not a share/export surface. Exporting is the certified-report path (Brief 29) with its own custody
  caution. This screen is review only.
- `[A]` Not an edit surface. Read-only, integrity-preserved.

## §5 — GUARDS
- `[A]` §0a: review lives on the Visible/app side, never in the Hidden facade, never a tell.
- `[A]` Flag-gated on ENVELOPE_ENCRYPTION_ENABLED. Flag off → the screen does not exist / is unreachable.
- `[A]` Additive: no trigger/capture/closure/dispatch/custody file changed in behavior. It reads existing
  ciphertext via the existing decrypt path; it adds a viewing surface, nothing more.

## ACCEPTANCE
- `[L]` Owning survivor opens a capture → decrypts client-side → audio plays / video plays / transcript renders.
- `[L]` Server never sees plaintext — prove it cannot decrypt what she viewed.
- `[L]` Unlimited: open the same capture repeatedly — no cap, no counter, no cooldown surfaces.
- `[L]` Quick-exit instantly clears the decrypted view.
- `[L]` Backgrounding / idle clears the decrypted view; nothing persisted to disk.
- `[L]` A non-owner (different account, and any role) cannot decrypt or view — refused.
- `[L]` No autoplay/loop; opening is deliberate.
- `[A]` §0a Hidden byte-identical; flag-off makes it unreachable; safety floor unregressed.

## DONE
A survivor can review her own captured evidence — audio, video, transcript — decrypted on her own device,
read-only, integrity preserved, as often as she needs with no cap. Protective controls (deliberate open,
quick-exit, auto-hide, in-memory only) guard the moment of exposure without ever rationing her access. No other
role can reach it. Flag-gated, additive, facade untouched. Committed, pushed, both halves currency-asserted.

---

# ADDENDUM — THE REVIEW SCREEN LAYOUT (build this UI)

Reference: Royce's layout sketch. This is the concrete screen for §1-§5 above.

## LAYOUT
- **Video/scene pane** (top-left): the decrypted video/scene capture, playing.
- **Audio waveform + transport** (mid-left): waveform of the decrypted audio with play/pause, reset, cursor-select
  (scrub), select-capture, and Close Dashboard controls.
- **Selected capture** (bottom-left): the chosen still/image + auto-populated DATE and TIME (from the event
  timestamp), plus a calm note: "Any information you can provide. Do not rush or pressure yourself."
- **Summary** (top-right): People — Aggressor(s) / Victim(s) / Tone / Weapon(s) / Danger(s).
- **Transcript replay** (mid-right): rolling transcript, synced to playback.
- **Location** (bottom-right): Start location, Traveling Y/N (if Y, expand a path; if N, no expand), map pin from
  coordinates (map tiles — no external geocoder in the live path; coordinates are source of truth).

## THE SUMMARY PANEL — how it populates (the locked rule)
- The summary **develops in real time as she replays the recording**, sourced from the EVENT RECORD — a static
  replay of what the system actually captured/structured during the incident. It is **not** AI analyzing the
  media and asserting facts.
- Whatever the event record genuinely contains is what shows. If a field has no recorded data, it stays empty —
  the system never infers or fills it.
- `[A]` **Read-only.** She cannot edit the system-derived summary — it is evidence, it developed as the event
  happened.
- `[A]` **The ONLY thing the survivor may add is an actual NAME on a person.** The system never writes a human's
  name — Aggressor(s)/Victim(s) stay unnamed unless she attaches a real name. That single field is hers to add;
  everything else is read-only replay.
- `[A]` No AI asserts who someone is, their intent, the "tone," or the "danger level" as a judgment — those
  fields show only what the record itself captured, verbatim/structured, never a model's interpretation.

## CONTROLS (map to §2 protective controls)
- Play/Pause, Reset, Cursor-Select (scrub), Select-Capture, **Close Dashboard** (= quick-exit; instantly clears
  the decrypted view).
- Deliberate open, no autoplay on entry. Auto-hide on background/idle. In-memory only.

## ACCEPTANCE (additional to §-above)
- `[L]` Summary fields populate ONLY from the event record; a field with no recorded data stays empty (no
  inference, no AI fill).
- `[L]` Summary is read-only; the only survivor-addable element is a name on a person.
- `[L]` Adding a name persists to HER record only (sealed under her key), never alters the signed evidence zone.
- `[L]` Close Dashboard instantly clears all decrypted media/transcript from view.
- `[L]` Map renders from coordinates with no external geocoder call in the live review path.

---

# ADDENDUM 2 — NAVIGATION (door in AND door out, §0a-safe)

The dashboard needs a way in and a way out — no dead ends — with one covert constraint the console doesn't have.

## IN
- Reachable from the survivor's app/settings (Visible side) via a clear control (e.g. "Review" / "My reports" /
  the report area).
- `[A]` NEVER reachable from, or visible in, the Hidden facade. No entry point, no tell, in covert mode — the
  entry point existing is itself a disclosure.

## OUT
- Persistent, obvious way back to the app from the dashboard and every sub-view — one tap back.
- **"Close Dashboard" does double duty: normal exit AND quick-exit.** It instantly clears the decrypted view and
  returns to a neutral app screen. Fast, obvious, always present — never buried in a menu.

## RULE
- No page strands the user. Dashboard → app in one action. Any evidence sub-view → dashboard home in one action.
- Nav gated on Visible skin; dashboard and its entry never render in the Hidden facade.
- Back/exit clears decrypted media from view (ties to §2 auto-hide/quick-exit).

## ACCEPTANCE (additional)
- `[L]` Enter dashboard from app → move between panels → exit to app. No dead end.
- `[L]` Covert mode → no dashboard entry point anywhere, no tell.
- `[L]` Close Dashboard clears all decrypted media AND returns to a neutral screen in one action.
