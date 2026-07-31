# BRIEF — CAPTURE CONTINUITY + PLAYBACK (B → A → C → D)

**Root fixes, not patches. The regression is DELIVERY starvation, not a capture cap (diagnosis confirmed no cap
exists). Restore the SITUATION signal to the coordinator, constrain chunk size, fix playback, and add a
forensic-grade remux for the evidence artifact.**

Standing constraints apply. Restore point first. §0a Hidden byte-identical. Trigger never gated/taxed. Both
halves currency-asserted. Each item its OWN commit with its OWN [L] proof so any one reverts alone.
Prove [L] on a real device.

**Order: B → A → C → D. Reason: B stops the life-safety signal being starved; A stops the queue being flooded;
C makes capture watchable; D makes the evidence court-grade.**

**DO NOT TOUCH: triggerAlert, the closure path, the classifier itself, config.ts timing, or the rear-camera
selection. The chunks are correct for a live feed — the problem is their size and delivery order, not the
capture firing.**

---

## ITEM B — PRIORITY UPLOAD QUEUE (life-safety; restores SITUATION) — FIRST
The serial upload queue lets bulky video chunks head-of-line-block the small classifier/SITUATION/origin
messages, so the coordinator's SITUATION summary never populates. Fix the ordering.

- `[A]` Small life-safety items (classifier results, SITUATION, origin, location) drain **ahead of** bulky video
  chunks. Video must not block them.
- `[A]` Lane derived in memory from `item.kind` — **no schema change, no device-DB migration**, items already
  queued on a phone unaffected. One file: `upload-manager.ts`.
- `[A]` **Retain single-flight** draining — this changes ORDER, not concurrency. No upload-storm.
- `[A]` Chunk order AMONG chunks is preserved (playback depends on it).

**[L]** Trigger → speak threat keywords → SITUATION populates live on the coordinator view while video is still
uploading. The classifier signal is never starved behind video.

## ITEM A — CONSTRAIN THE ENCODER (stops the flood) — SECOND
Unconstrained bitrate produces ~0.9–1.5 MB/s chunks that outrun the uplink and flood the queue.

- `[A]` In `media-capture.ts` ONLY: set `videoBitsPerSecond` and `width`/`height`/`frameRate` as **`ideal`**
  (never `exact` for resolution — `exact` would defeat the rear-lens availability ladder).
- `[A]` Rear-camera selection and the availability ladder (exact:environment → ideal:environment → any →
  audio-only) are **untouched.**
- `[A]` **Test dependency (called out):** `report-destinations.guard.test.ts` asserts ladder rung 3 is literally
  `{}`. Rewrite ONLY that one assertion to prove "rung 3 constrains quality, not camera," leaving the
  neighbouring `facingMode` assertions alone.

**[L]** Capture runs continuously; chunk size is bounded; the queue keeps up; rear lens still used; ladder proofs
still pass.

## ITEM C — PLAYBACK ASSEMBLY (makes capture watchable) — THIRD
Independent MediaRecorder segments are separate media files; byte-concatenation cannot work (only segment 0
carries a container header — that is the "~1 second" artifact). Fix with **sequential segment playback**.

- `[A]` Play segment 0, then 1, advancing on `ended` — the LIVE coordinator view and the survivor EVIDENCE REVIEW
  dashboard both use this. Accepted trade-off: **cross-segment seeking is approximate on these two surfaces.**
  This is acceptable — they are review surfaces, not the court artifact.
- `[A]` On the EVIDENCE REVIEW dashboard: **play / pause / stop work, and pause holds a clean frame.** Approximate
  seek is acceptable here. A paused frame in Review is NOT to be treated as forensic-exact — the forensic version
  is the remuxed report (Item D).
- `[A]` The ordered-segment contract lives ONCE in `packages/shared` with its own unit test; both players (the
  Worker's dashboard JS and the PWA's `playback.ts`) conform, so they cannot diverge.
- `[A]` `playback.ts` must `revokeReview` EVERY segment URL, not just one.
- `[A]` Reuse existing endpoints — `/v1/c/:id/audio/:sequence` and `/audio/stream` SSE already exist; a playlist
  can extend live during an active event. `/audio/full`'s only two consumers are in `dashboard/page.ts`;
  `recipient-page.ts` and `cad-summary.ts` are untouched.

**[L]** Against an existing event with ≥4 chunks: full capture plays in order start to finish (not one second);
pause holds a frame on the Review dashboard.

## ITEM D — FORENSIC REMUX FOR THE EVIDENCE ARTIFACT (court-grade) — FOURTH
"Approximate seeking" is unacceptable for evidence. The GENERATE-REPORT artifact must be one seamless,
frame-accurate, fully-seekable file — NOT fragmented segments.

- `[A]` On **report generation only** (never any live path), remux the captured segments into ONE properly-formed,
  frame-accurate, fully-seekable file (MP4/WebM), bundled with the report document. Exact seeking. Court-grade.
- `[A]` Remux runs on the evidence/report path, NOT the live coordinator or trigger/capture path — it adds no
  failure mode to a live alert. If remux fails, report generation fails honestly; it never affects capture.
- `[A]` **Chain-of-custody integrity (critical):** the signature/verification traces to the ORIGINAL captured
  chunks. The remuxed file must be a **faithful, verifiable reassembly** of those signed chunks — byte-complete
  against them — NOT a separately-signed substitute that could be questioned. Confirm the remuxed report file
  verifies against the original chunk hashes.
- `[A]` If a still-frame "capture"/export exists anywhere for evidentiary use, it is generated against the
  remuxed file — never a fragmented-playback screenshot.

**[L]** Generate a report from an event → the bundled video is one seamless file → seek to an exact timestamp and
it lands frame-accurate → the remuxed file verifies against the original signed chunks → chain of custody holds.

---

## THE THREE-TIER MODEL (state it in the report so it can't drift)
| Surface | Playback | Seeking |
|---|---|---|
| Live coordinator view | fragmented sequential | approximate — acceptable |
| Evidence Review (survivor dashboard) | fragmented sequential | approximate — acceptable (review, not court) |
| Generate Report (evidence artifact) | **remuxed single file** | **frame-accurate, forensic** |

## THE ONE UNRESOLVED THING (named, not guessed)
The 461KB→865KB chunk-size jump that predates the rear-camera deploy has no explaining commit and points to a
different device/browser build; events carry no device id by design so it can't be settled from prod. Item A's
bitrate constraint makes the app resilient to it regardless of cause. Leave it named, do not invent a cause.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR per item. Real-device proof per [L]. Confirm rear camera untouched, classifier
untouched, trigger untouched. Confirm the remuxed report verifies against original signed chunks. Restore point
id. Deployed hash per commit, both halves asserted.
