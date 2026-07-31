# BLACK BOX — FIX BRIEF 17 — Check-in Regression + Location Correlation (spec)

**Floor:** current known-good (Brief 15 + 16). Do not regress.
**Mode:** prove on deployed production, both Present modes.
**Scope of this brief:** §0 and §1 build now. §2 is SPEC ONLY — do not build until the HERE key is provisioned.

---

## SECTION 0 — Visibility toggle: regression fix + relabel  `[A→L]`  *(BUILD FIRST — live safety control)*

The Present toggle in Settings is dead — switching it does not change covert/overt state. This is a
safety-critical regression (a user cannot choose to be hidden) and gets fixed first.

**Diagnose first.** Find what severed the toggle's effect — almost certainly collateral from the Brief 15/16
settings rework (same failure family as check-in). Identify the break before patching; report it in the commit.

**Relabel — exact mapping, do not invert:**
- The control is a two-ended, both-ends-labeled toggle: **Visible ←→ Hidden** (retire "Present").
- **Hidden = covert** = Stillpoint breathing facade. **This is the DEFAULT.**
- **Visible = overt** = the true-black/amber/red instrument.
- ⚠ The mapping is load-bearing: if wired backwards, a user selecting **Hidden** would get the instrument
  screen in front of an aggressor — the worst-case failure. Pin the mapping; never infer an off-state.
- Keep the existing 2-step confirmation when switching toward Visible (leaving covert is deliberate).

**Restore function:** toggling actually switches the rendered mode end to end — facade ↔ instrument — and
the choice persists across launches. Must hold the §0a covert-active invariant: in Hidden, an active event
stays byte-identical to dormant-Hidden; the instrument view never appears while Hidden.

**Acceptance:**
- `[A]` toggle labeled Visible/Hidden, both ends; Hidden is default for a new account.
- `[L]` set Hidden → facade renders (login + dormant); activate covertly → screen stays facade, no instrument.
- `[L]` set Visible (with 2-step confirm) → instrument renders; flip back to Hidden → facade returns.
- `[A]` choice persists across app relaunch; mapping is correct (Hidden=covert, Visible=overt).

---

## SECTION 1 — Check-in: fix the regression + button  `[A→L]`  *(BUILD NOW)*

Check-in is currently broken: submission goes nowhere and no one is notified. A safety feature silently
doing nothing is worse than not having it. The button change is cosmetic; **the dead delivery path is the
regression and the priority.**

**Diagnose first, don't just rebuild.** Check-in was intended to work; find *what severed the delivery path*
(likely collateral from the Brief 15/16 notification/WebSocket rework). Identify the break before patching,
or it will regress again. Report what broke it in the commit note.

**Build:**
- **Remove the location checkbox.** Check-in is a **single button**.
- **Location captured and sent automatically on tap** — no opt-in toggle. (This is the one place location is
  user-initiated; capture the current fix at the moment of tap.)
- **Restore the delivery path:** on tap, check-in must actually notify the recipient with the user's status +
  timestamp + location, and the user must get clear confirmation it was delivered (no silent success either).
- **Recipient: the guardian** (existing check-in-recipients default). ⚠ ROYCE — confirm guardian is correct;
  if it should target someone else, say so and this one line changes.
- Check-in remains **dormant-only** — no capture session, no coordinator, no active event. It is a "still OK"
  heartbeat, not an alert.

**Acceptance:**
- `[A]` no checkbox in the check-in UI; check-in is a button; tapping captures location without a prompt.
- `[A]` submission hits the delivery path and notifies the recipient (verify send/delivery log) — not a no-op.
- `[L]` real tap on the deployed app → recipient receives status + time + location; user sees delivered
  confirmation; nothing fires if dormant guard is somehow bypassed (stays dormant-only).

---

## SECTION 2 — Location correlation layer  *(SPEC ONLY — DEFERRED — DO NOT BUILD)*

Captured now so it's ready when the HERE platform key is provisioned. **Do not implement under this brief.**

**Intent:** anywhere a location is computed or delivered — active stream, dashboard pin, dispatch summary,
check-in, last-known-on-feed-loss — it must go out as coordinates **plus** correlated address and road-context,
never bare coordinates. One enrichment layer, every consumer.

**Architecture (when built):**
- **Single server-side correlation function in the worker.** Every location path calls it — one door, no
  exceptions, so no route can deliver bare coords while another delivers enriched.
- **Provider: HERE REST APIs, server-side** (Geocoding & Search for reverse geocode; routing/road context for
  road name, direction, mile marker/landmark). **Not** the HERE JavaScript API or client SDK — those expose the
  key and don't log to the evidence chain. Build **provider-agnostic** behind an internal interface so the
  provider can be swapped without touching call sites.
- **Pipeline:** raw fix (lat/lng + speed/heading) → reverse geocode to nearest street address → if moving above
  a speed threshold, add road name + direction (from heading) + nearest mile marker/landmark → if stationary,
  address + nearest landmark.
- **Output object attached everywhere:** `{ lat, lng, address, road, direction, marker_or_landmark, ts }`.
  Coordinates + map pin remain; enrichment is additive, never a replacement.
- **Written into the event record (Module 7)** so correlation is part of custody/evidence, not just display.
- **Every consumer reads the one enriched result** — dashboard, dispatch CAD summary, last-known latch — none
  call HERE independently.

**Non-negotiables (when built):**
- Server-side only; HERE key as a worker secret (same pattern as LINE/Twilio/SendGrid).
- **Graceful degrade:** if HERE is slow/down, location delivers as coordinates + map **immediately**;
  enrichment fills in when it returns. A geocoding hiccup must NEVER block or delay the actual location
  reaching the coordinator. Coordinates-now beats address-late — this is safety-critical.
- **Cache identical fixes** to control cost — do not re-geocode a stationary point repeatedly.

**Prerequisite (on Royce, not Claude Code):** create a HERE platform account, obtain an API key, add it as a
worker secret. Build does not start until the key exists.

---

## DONE
§0 + §1: each passes on deployed production both modes; checks added to acceptance suite; previously-green
still passes; committed; deployed. Phone sign-off before tagging known-good. §2 not built — spec on record
for the post-key pass.
