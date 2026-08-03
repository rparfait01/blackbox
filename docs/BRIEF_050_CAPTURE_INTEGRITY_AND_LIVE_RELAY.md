# BRIEF 50 — CAPTURE INTEGRITY AND LIVE RELAY

**Status:** §0 diagnosed and reported; re-scoped by Royce on the evidence; build items 1–6 done
and verified locally. Not deployed — session request ceiling.

## CORRECTIONS

**BRIEF 050 (this brief's own framing) — corrected to read:**
"Both observed defects are DOWNSTREAM, on the coordinator's playback surface. Capture is not
mode-asymmetric: it diverges at exactly one line (`captureModeForSource`), keyed on activation
SOURCE rather than Present mode, and that divergence is deliberate. Do not rewrite the capture
core."
Path: `workers/api/src/dashboard/page.ts`, `apps/pwa/src/lib/transcription/speech-recognition.ts`

*(The brief framed this as "a mode asymmetry in shipped capture code, same class as the
visible-trigger regressions." §0 disproved that on captured evidence. Recorded so the framing is
not repeated.)*

**BRIEF 022 / TRIGGER-UNIFY — corrected to read** (as the brief specified):
"Mode is display-only for capture as well as for triggering. One capture core, one transcription
path, one classification path. Present mode selects what the survivor sees and nothing else."
Path: `apps/pwa/src/capture-mode-independence.guard.test.ts`

## §0 FINDINGS (evidence, not inference)

**0.1 — Video is NOT a platform limit.** Production `chunks_index`: 20 chunks of
`video/webm; codecs=vp09.00.10.08,opus`, 36–126 KB. It captured and stored.

**0.2 — Two downstream defects, one root each.**
1. `dashboard/page.ts` mapped every `video/webm` to `codecs="vp8,opus"`. The recording is VP9.
   `isTypeSupported` accepts the VP8 string, MSE engages, VP9 bytes are appended to a SourceBuffer
   declaring VP8, nothing decodes — no picture AND no voice, because the audio is muxed in the
   same stream. Hidden produces `audio/mp4`, which mapped correctly, so Hidden played.
2. The video stream was routed to an `<audio>` element, which renders no picture regardless.
   The `<video>` panel was a manual-refresh replay of `/audio/full`, never live.

**0.3 — No zero- or one-byte chunks on production.** Minimums 2.7 KB (audio), 36 KB (video). The
Brief 40 one-byte shape does not appear here; this is "audio present, unplayable in review."

**0.4 — Relay inventory.** Audio: MSE, live. Location + summary: `/state` poll, live. Video: one
progressive load, not live. No stream declared its own state. SSE still closes permanently on
error.

## CARRIES FORWARD (open, owned by) — corrected 2026-08-04

The brief's original list was stale. Actual state:

- **SHIPPED since:** Brief 35 Fix B, Brief 41, Brief 42, Brief 43, Brief 23 Fix A, Brief 53,
  Brief 33 Fix B. `master` is 9 commits behind HEAD, not 157.
- **Brief 41 acceptance 2** — the timing oracle was CLOSED in Brief 43 by moving the work into
  `waitUntil`, not by a delay. Recorded as a correction against Brief 41 §B.
- **Brief 51** — device session; owns Brief 50 acceptance 2, 3, 4, 5, 6, 7, 8, 9, 11 (every item
  requiring a real device) and the §0.2 microphone-contention proof below.
- **`CF_ANALYTICS_TOKEN`** still unset; headroom reads `NOT MEASURED`.
- **Nothing is armed.** Brief 36 item 12 and Brief 2 Fix A §E3 wait on the device session.
- **Brief 50 deploy + master push** wait on a fresh session (request ceiling).
