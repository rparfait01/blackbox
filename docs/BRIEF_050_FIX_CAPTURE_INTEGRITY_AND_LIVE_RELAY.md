# BRIEF 50 — CAPTURE INTEGRITY AND LIVE RELAY

**Type:** FIX
**Priority:** P0 — **PREEMPTS THE ENTIRE QUEUE.** Capture is the premise of the product. Every
custody, encryption, and retention brief shipped so far protects a payload that must first exist.
**REQUIRES:** nothing. Ship before Brief 35 Fix B, Brief 42, and everything after.
**Floor:** all shipped work. Zero regression to trigger (both modes), cascade, closure,
live-alert lock, §0a facade, deploy gate, retention lock.
**Mode:** **DIAGNOSIS FIRST.** §0 is a report, not a build. No code is written until §0 is
answered on captured evidence.
**Number:** 50. Numbers 44–49 are retired unissued per Brief 34 rulings.

---

> **THE OBSERVED FAILURE — from a live two-mode test. This is the specification.**
>
> **VISIBLE mode:** trigger fired correctly; coordinator took coordination from the dashboard as
> support contact; **no video displayed**; **summarizer did not function** — no words picked up,
> no summary produced. In playback and evidence review the record shows it recorded or attempted
> to record, but there is **no voice and no summary**.
>
> **HIDDEN mode:** trigger fired correctly; coordinator took coordination from the dashboard;
> **no video recording again**; **summarizer worked**.
>
> Two distinct defects, and they are not the same defect:
>
> 1. **Video absent in both modes** — may be a platform limit, not a regression. §0 establishes
>    which before anything is built.
> 2. **Audio and summarization work in Hidden and fail in Visible** — a mode asymmetry in shipped
>    code. Same class as the visible-trigger regressions that took Briefs 18, 22, and
>    trigger-unify to close. Capture must be mode-independent for the same reason triggering is.
>
> **The requirement, stated plainly:** on trigger in either mode, capture starts immediately and
> the coordinator who takes coordination can see video, hear audio, see location, and see the
> summary of what is happening, as near real time as the architecture allows. If capture is not
> consistent and stable across both modes, nothing downstream matters.

---

## CORRECTIONS

**BRIEF 022 / TRIGGER-UNIFY — corrected to read:**
"Mode is display-only for capture as well as for triggering. One capture core, one transcription
path, one classification path. Present mode selects what the survivor sees and nothing else. A
capture behaviour that differs between Hidden and Visible is a defect, not a configuration."
Path: `apps/pwa/src/lib/capture/media-capture.ts`

---

## §0 — DIAGNOSE BEFORE BUILDING `[REPORT ONLY]`

**Write no fix until this is answered with evidence. Report and stop.**

### 0.1 — Video: regression or platform limit

- Does the PWA request a video track at all? In which mode, on which code path?
- Has video capture **ever** produced a stored object in any environment? Query, do not infer.
- What does the platform permit: iOS Safari PWA video recording in foreground, in background,
  with screen locked. Android Chrome PWA, same three.
- **State the honest answer:** if video is not achievable in a PWA on the survivor's platform, no
  section of this brief produces it and the capability belongs to the Capacitor native wrap. Say
  so plainly rather than building something that half-works.
- If video is achievable in the foreground only, say what the survivor's realistic posture is
  during an event and whether foreground-only video is worth having.

### 0.2 — The mode asymmetry

- Trace the audio path in both modes from `MediaRecorder` construction to transcript row.
- Where do the two paths diverge? Name the line.
- Does Visible acquire a different track, a different constraint set, a different sample rate, or
  a different recorder configuration?
- Does the transcription or classification stage receive chunks in Visible at all, or receive
  them and produce nothing?
- **Is the audio present in the stored object and only the transcription missing, or is the audio
  itself absent?** These are different defects with different fixes. Play back a Visible-mode
  chunk and say which.

### 0.3 — What the evidence review actually shows

- The record shows "recorded or tried to record" with no voice. Determine: zero-byte chunks,
  silent audio, or audio present but unplayable in review.
- The one-byte chunk noted during the Brief 40 purge inventory belongs here — check whether it is
  the same shape.

### 0.4 — What the coordinator actually receives today

Inventory the live relay as built, per stream: audio, location, summary, video.

- Transport, cadence, and end-to-end latency from capture to coordinator display.
- Which are live during an event and which only appear after closure.
- The SSE streams are 60s with no reconnect on error (Brief 33 Fix A inventory) — establish what
  a coordinator sees when one drops mid-event.

---

## §A — ONE CAPTURE CORE

- One code path constructs the recorder, acquires tracks, and emits chunks. Present mode is read
  nowhere inside it.
- Mode selects presentation only: what renders on the survivor's screen.
- **Guard:** a test asserts no capture, transcription, or classification module reads Present
  mode. Structural, per the standing rule — assert against parsed structure, not source text.
- The covert no-regression rule is unchanged and absolute: in Hidden, the active-event screen is
  byte-identical to the dormant facade. Unifying capture must not leak a single pixel into it.

## §B — AUDIO IS THE FLOOR

Audio is the capability that works today in one mode and must work in both.

- Identical acquisition constraints in both modes. If a constraint must differ for a stated
  platform reason, name it and prove the output is equivalent.
- A capture producing zero-byte, one-byte, or silent chunks raises Brief 36 §D degradation. It is
  never recorded as a successful capture.
- **Arm-time verification:** before a survivor relies on it, confirm the microphone can be
  acquired and produces non-silent data. Overt — plain warning. Hidden — the Brief 36 §D cadence
  signal, same mapping, no second vocabulary.

## §C — TRANSCRIPTION AND SUMMARY

- One transcription path, one classification path, mode-independent.
- Transcription failure is declared, not silent. A capture with audio and no transcript reports
  that state; it does not present as a capture with nothing said.
- The summary the coordinator sees names its own state: live and updating, stalled, or
  unavailable — never a blank panel that reads as silence.
- Classifier internals stay undisclosed in every public-safe output, unchanged.

## §D — VIDEO, SCOPED HONESTLY

Governed entirely by §0.1.

- **If achievable in the PWA:** one path, both modes, same degradation contract as audio. Video
  failure never stops audio — audio is the floor and outranks video in every conflict.
- **If not achievable:** this brief states that, the coordinator surface says so explicitly rather
  than showing an empty video panel, and video moves to the Capacitor wrap with its dependency
  recorded. **Do not ship a video panel that renders nothing** — a blank pane reads as "nothing
  happened," which is the same lie as a blank summary.
- Video is never a precondition for a live event, a cascade, or evidence retention.

## §E — LIVE RELAY

The coordinator who takes coordination sees the situation, not a post-mortem.

- Audio, location, and summary reach the coordinator as near real time as the chunked architecture
  allows. State the achieved latency per stream; do not promise real time and deliver a poll.
- **Every stream declares its own state on the coordinator surface: live, degraded, or stopped.**
  A stream that silently stops is worse than one that reports stopped — that is the Brief 33 Fix A
  §A rule applied to the data rather than the view.
- SSE reconnect: the streams currently close permanently on error. A coordinator mid-event must
  not lose audio to one transient failure. Bounded backoff with a ceiling, per Brief 33 Fix A §C
  — never a fixed-interval retry.
- Relay cost is bounded and reported. A live event must not reproduce the request-volume failure.

## §F — ANTICIPATED GAPS

1. **Backgrounding.** iOS suspends foreground work when the screen locks or the app backgrounds.
   Audio persists; video does not. State exactly what survives in each mode on each platform, and
   make the coordinator surface reflect it rather than showing a stalled stream as live.
2. **Hidden mode constrains the UI, not the capture.** Any fix that makes Hidden capture "quieter"
   to preserve the facade is the wrong fix. The facade is a rendering property.
3. **The encryption path.** Brief 36's state machine sits between capture and upload. Confirm a
   Visible-mode capture is not failing at the encryptor rather than the recorder — §0.2 must rule
   this in or out explicitly.
4. **Permissions.** A mode-dependent permission prompt, or a prompt suppressed in Hidden, would
   produce exactly this asymmetry. Check it early.
5. **Do not fix the symptom.** If §0 finds the two modes diverge at one line, fix the divergence —
   do not add a Visible-mode special case. A special case is how the asymmetry arrived.

---

## ACCEPTANCE

Every item on a real device, both Present modes, on real captures. This brief cannot be closed
headlessly.

1. §0 answered in full and reported before any code was written.
2. Visible: trigger → audio captured, non-silent, stored, transcribed, summarized. Coordinator
   sees the summary updating live. **Screenshot.**
3. Hidden: identical result. **Screenshot.** Facade byte-identical to dormant throughout.
4. Both modes: coordinator takes coordination and sees audio, location, and summary. Achieved
   latency reported per stream.
5. Video: per §0.1's finding. Either it works in both modes and is screenshotted, or the brief
   records that it is not achievable in the PWA and the surface says so explicitly.
6. Playback and evidence review: voice audible, transcript present, summary present. The failure
   originally observed is reproduced on the old build and shown absent on the new one.
7. Deny the microphone → arm-time warning in Overt, cadence signal in Hidden, degradation
   recorded, **alert still fires and contacts still receive.**
8. Zero-byte, one-byte, and silent chunks → degradation raised, never recorded as success.
9. Drop an SSE stream mid-event → backoff reconnects, coordinator surface shows degraded then
   live, audio resumes.
10. Guard asserts no capture, transcription, or classification module reads Present mode.
11. Trigger latency unchanged in both modes. Both numbers reported.
12. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- **Brief 35 Fix B** — staging send suppression and the operator alert channel. Resumes after this
  brief. Staging still holds a live SendGrid key; that gap is open.
- **Brief 41 acceptance 2** — the timing oracle. +23ms on existent addresses, consistent across
  the distribution. Fix by equalising the work in Brief 41 §B. Not a sleep, not a random delay.
- **Brief 41 acceptance 3, 6, 7** — blocked on Brief 35 Fix B.
- **Brief 42** — headers and session rotation; facade-diff harness is its first task.
- **Brief 43** — bounds; closes the audit set. **Brief 23 Fix A** — tenancy.
- **Brief 2 Fix A acceptance 2, 7, 8, 11** — device session.
- `CF_ANALYTICS_TOKEN` unset; headroom reads `NOT MEASURED`. `master` 157 commits behind HEAD.
- **Nothing is armed.** Brief 36 item 12 and Brief 2 Fix A §E3 wait on the device session.
