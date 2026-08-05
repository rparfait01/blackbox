# BRIEF 51 — DEVICE SESSION: RUN SHEET AND RESULT TEMPLATE

**Purpose: one pass, not five.** Every open device-dependent item across Briefs 42, 50, 51, 55, 56
and 58 is here, ordered so nothing needs a second trigger to answer.

**Print this or keep it open. Fill the RESULT column as you go — the template at the end is what
comes back to me.**

---

## BEFORE YOU START — 4 minutes, saves the run

| # | Do | Why it matters |
|---|---|---|
| P1 | **Force-reload the PWA on the survivor phone.** Close the app, reopen, pull to refresh. | The service worker holds the old bundle until a reload. Every gesture and capture fix from `fefb037` onward is only on the reloaded build. **A run on a stale bundle answers nothing.** |
| P2 | **Confirm the build.** Settings → bottom → `build <sha>`. | It must match the sha I last deployed. If it does not, the reload did not take. |
| P3 | **Close every old coordinator tab** on every device. | Stale tabs are what spent a million requests. Also stops old JS confusing the results. |
| P4 | **Have the second device ready** (coordinator) with the LINE/email alert visible but unopened. | Item 6 depends on *when* you open the link. Opening early destroys the measurement. |

**Devices:** survivor phone = the one that triggers. Coordinator device = the one that opens the
dashboard link. **They must be different devices**; several items compare them.

---

## THE RUN — 14 items, 3 triggers

### TRIGGER 1 — VISIBLE, let the cascade run (do not claim)

Open the app in Visible mode, tap to activate. **Do not open the coordinator link yet.** Speak
normally for ~60 seconds; include the phrase *"I'm gonna cut your throat"* once, deliberately, at
around 20 seconds.

| # | Check | What to record |
|---|---|---|
| **1** | **Transcription starts.** Coordinator dashboard → Live transcript panel. | Does text appear at all? Y/N, and roughly when. *(This is the regression I introduced in Brief 55 §C and fixed in `fefb037` — the whole point of this item is whether the user-gesture fix worked.)* |
| **2** | **Capture is claimed honestly.** Same dashboard, Situation panel + Audio panel. | Does it say `Audio + location active`, or `NO AUDIO RECEIVED`? Record the exact words. |
| **3** | **Video panel.** Live camera section. | Video area present? Playing? Or "No camera feed"? |
| **4** | **`?diag=1`.** Add `&diag=1` to the coordinator URL, reload, scroll to *Media capability probe*. | **Photograph or copy the whole block.** This decides LL-HLS vs ManagedMediaSource and I cannot get it any other way. |
| **5** | **Cascade timing.** Let it run past 40 seconds without claiming. | Which contacts received an alert, and roughly how far apart. |
| **6** | **Claim, and note the time.** Now open the link and press **TAKE COORDINATION**. Then read the *Who else was notified* panel. | The exact line it prints: "N of M contacts were notified before you took coordination." |

**Then close the event: press and HOLD the closure control until the ring completes.**

| # | Check | What to record |
|---|---|---|
| **7** | **Closure reads SAT, not DURESS.** Coordinator dashboard, closure window. | `SAT` or `UNSAT · DURESS`. **This is the 18-for-18 defect.** |
| **8** | **Now do it again on the next trigger with a deliberate TAP** (press and release immediately). | Expected: **nothing is sent at all** — the sheet stays open. Record what happens. |

---

### TRIGGER 2 — HIDDEN, immediately after closing trigger 1

Switch to Hidden. Double-tap to activate **within 30 seconds of closing trigger 1.**

| # | Check | What to record |
|---|---|---|
| **9** | **Both devices acquire.** Coordinator dashboard. | Does capture start? Camera *and* microphone, or one, or neither? *(Brief 55 §C — the release race. Trigger 1's tracks must have been freed.)* |
| **10** | **Hidden captures video.** Same panel. | Video present in Hidden? *(It must be — the posture gate was deleted. Hidden and Visible now capture identically.)* |
| **11** | **The facade is intact.** Look at the survivor phone screen during the alert. | Anything visible at all? Any indicator, banner, preview, colour change? **Expected: nothing. It is a meditation app.** |
| **12** | **Close with a TAP** (item 8's test). | What the sheet does, and what the coordinator sees. |

---

### TRIGGER 3 — the replay and evidence pass (no new trigger needed if T1 captured)

| # | Check | What to record |
|---|---|---|
| **13** | **Playback on the coordinator's iPhone.** Open the closed event's dashboard on the iPhone, press *Play recording so far*. | Does it play? Video and audio, or audio only, or nothing? *(The `avc1` codec fix is confirmed at the recording end; nobody has watched it play back on iOS.)* |
| **14** | **Evidence Review on the survivor phone.** Settings → Evidence review → pick trigger 1. | (a) Does the recording open and play? (b) **DANGER(S) and WEAPON REFERENCES — copy the exact text.** (c) Does the summary match the coordinator's threat badge? |

---

## AFTER — 2 minutes

| # | Do | Why |
|---|---|---|
| A1 | **Leave every tab open for 5 minutes, then close them all.** | I will check the telemetry for what each surface cost. First real per-route data. |
| A2 | **Do NOT delete the recordings yet.** | Items 13/14 need them, and the §C purge is a separate deliberate pass. |

---

## RESULT TEMPLATE — paste this back filled in

```
BUILD (P2):            ______________
SURVIVOR DEVICE:       ______________   COORDINATOR DEVICE: ______________

TRIGGER 1 — VISIBLE
 1 transcription           [ Y / N ]  appeared at ~____s   notes:
 2 capture claim wording   "________________________________________"
 3 video panel             [ playing / area-but-blank / no camera feed ]
 4 ?diag=1 block           (paste or photo)
 5 cascade                 contacts reached: ______  spacing: ______
 6 N of M line             "________________________________________"
 7 closure (HOLD)          [ SAT / UNSAT·DURESS ]

TRIGGER 2 — HIDDEN
 9 acquisition             [ audio+video / audio only / neither ]
10 hidden video            [ Y / N ]
11 facade intact           [ nothing visible / SOMETHING VISIBLE: ______ ]
12 closure (TAP)           sheet did: ______   coordinator saw: ______

REPLAY
13 iPhone playback         [ video+audio / audio only / nothing ]  error text: ______
14 evidence review         opens: [ Y / N ]
   DANGER(S):              "________________________________________"
   WEAPON REFERENCES:      "________________________________________"
   matches coordinator?    [ Y / N ]

ANYTHING THAT SURPRISED YOU:
```

---

## WHAT EACH ITEM CLOSES

| Item | Closes |
|---|---|
| 1 | Brief 55 §A transcription regression — the one I introduced |
| 2 | Brief 55 §A2 honest capture status |
| 3, 10 | Brief 56 §3 video panel; Brief 50 §D Hidden-video correction |
| 4, 13 | The LL-HLS vs ManagedMediaSource decision; Brief 55 §B codec fix |
| 5, 6 | Brief 56 §A2 cascade reach reporting |
| 7, 8, 12 | Brief 56 §1 duress — 18 of 18, the tap threshold |
| 9 | Brief 55 §C track release |
| 11 | §0a facade — the floor under everything |
| 14 | Brief 55 §D summary vocabulary; Brief 52 classifier output as she sees it |

**Not in this run, deliberately:** nothing is armed. Brief 36 item 12 and Brief 2 Fix A §E3 stay
closed until this pass reports clean.
