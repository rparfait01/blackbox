# BRIEF — CAPTURE CONTINUITY: ENCODER BUDGET · LIFE-SAFETY PRIORITY · PLAYBACK ASSEMBLY

**Capture never stopped. Delivery collapsed, and playback lied about it.**

Three independent items. Each is separately shippable, separately provable on a real device, and
separately revertable. Ship in the order **B → A → C** — B stops the life-safety signal being
starved, A stops the queue being flooded, C makes the stored bytes watchable.

Standing constraints apply. §0a Hidden byte-identical. Trigger never gated or taxed. Capture
retention never suspended. Both halves currency-asserted. Prove `[L]` on a real device.

---

## §0 — DIAGNOSIS (established, not assumed)

Per `CLASSIFIER_RULESET.md` + `BLACKBOX_FUNCTIONAL_MAP.md`, capture must be continuous
(audio + video + location) feeding the live classifier → SITUATION summary. It is not.

**There is no length cap anywhere.** `recorder.start(1000)` is a *timeslice* (one chunk per
second), `capture.stop()` runs only on teardown, and `/v1/c/:id/audio/full` streams every chunk
with no limit. Anything that looks like "raising a cap" is fixing a defect that does not exist.

`chunks_index.createdAt` is server-side `Date.now()` at insert (`workers/api/src/index.ts:1699`),
so the gaps below are **upload latency**, not chunking cadence:

| event | when (UTC) | duration | chunks on server | max chunk | classifs | transcripts |
|---|---|---|---|---|---|---|
| `09b74bd8` | 2026-07-26 13:33 | 29 s | **30** (1/s ✓) | 461 KB | 5 | 3 |
| `30ab7d04` | 2026-07-29 07:58 | 67 s | **4** | 865 KB | **0** | **0** |
| `42e9bd00` | 2026-07-29 23:26 | 108 s | **4** | 1501 KB | **0** | **0** |

In `42e9bd00`, seq 0 → seq 1 took **95 seconds**, then seq 2 landed 0.87 s later — gap-then-burst,
the signature of retry backoff plus head-of-line blocking.

**Not caused by the rear-camera change.** `30ab7d04` shows the identical failure (4 chunks, zero
classifications) at 07:58 UTC — **4.5 hours before `0922bd9` reached production (~12:35 UTC)**.
The rear lens *aggravates* it (865 KB → 1501 KB per chunk, ~1.7×) because nothing constrains
resolution, but it did not create it. Unattributed: no commit between 07-26 and 07-29 touched
capture or encoding, and the reported mime shifted from `video/webm;codecs=vp9,opus` (our literal
request string) to `video/webm; codecs=vp09.00.10.08,opus` (a browser-normalised expansion) —
that points to a different device or browser build, not a commit. Events store no device
identifier by design, so this cannot be confirmed from prod and is not pursued further.

**The three defects, all originating in `8d0a645` (W2):**

1. **Unconstrained encoder.** ~1 chunk/s at 0.9–1.5 MB demands a *sustained* ≥1 MB/s uplink
   forever. Below that the queue falls behind without bound. Grep-proven: the only `width`/
   `height` in `apps/pwa/src/lib/capture/` is the 1px video-sink CSS.
2. **Strictly serial upload queue with head-of-line blocking.**
   `apps/pwa/src/lib/upload/upload-manager.ts:482` — `return; // preserve order` — plus a
   single-flight `draining` guard and backoff to 30 s. Locations, classifications, transcripts
   and origin share that queue and sit **behind** the video. The classifier fires every 5 s
   locally and produced ~21 results in `42e9bd00`; **zero** reached the server.
3. **Playback presents a byte-concatenation as one file.** `/audio/full` concatenates independent
   recorder segments (`index.ts:1398-1421`; admitted in comments at `dashboard/page.ts:731`).
   Only segment 0 carries a container header, so a player decodes ~1 s and stops — **that is the
   "~1 second."** `normMime` (`dashboard/page.ts:707`) has no `vp09` or `video/mp4` branch and
   mislabels the stream as vp8, so the MSE path cannot rescue it. The new
   `apps/pwa/src/lib/report/playback.ts` has the same flaw.

### DO NOT TOUCH

- The rear camera / `facingMode` ladder — camera *selection* is settled and correct.
- `triggerAlert` and the trigger core; the closure path; the classifier itself.
- `apps/pwa/src/lib/capture/config.ts` — the 1-second timeslice is CORRECT for a live feed. The
  problem is chunk **size**, never chunk **cadence**. Do not change the interval.
- The container/codec choice in `pickMimeType`. Changing the recording format to make segments
  concatenatable is a capture-path change and is explicitly out of scope (see C, deferred C3).

---

## ITEM A — ENCODER BUDGET (`media-capture.ts` ONLY)

**A chunk must fit the uplink it has to cross. Today nothing says how big it may be.**

- `[A]` Add a resolution and frame-rate preference to **every** video rung of the existing
  ladder, and a bitrate ceiling to the `MediaRecorder`. Target ≈ **720p / 24 fps /
  `videoBitsPerSecond: 800_000` / `audioBitsPerSecond: 64_000`** — about 108 KB per second, an
  order of magnitude under today's 1.5 MB and comfortably under the 461 KB that was working.
- `[A]` **`ideal`, NEVER `exact`, for `width`/`height`/`frameRate`.** An `exact` resolution adds a
  new hard-fail rung: a device that cannot hit it exactly would fall through to audio-only and
  lose video entirely. Only `facingMode` uses `exact`, and only on rung 1, and **that line is not
  touched by this item.**
- `[A]` Camera SELECTION is untouched. The `facingMode` rungs stay byte-identical, the ladder
  keeps all four rungs in the same order, and the rear lens remains rung 1.
- `[A]` **The bitrate options must never cost us a recording.** A browser that rejects
  `videoBitsPerSecond`/`audioBitsPerSecond` in the constructor must still record: attempt the
  options-bearing constructor, and on throw fall back to the current bare
  `new MediaRecorder(stream, { mimeType })` and then `new MediaRecorder(stream)`. Capture
  availability outranks capture budget — the same rule as the acquisition ladder.
- `[A]` Bitrate hints are advisory. No assertion may depend on a browser honouring them; the
  proof is the measured chunk size on a real device.
- `[A]` §0a: no UI, no indicator, no quality control anywhere. The survivor does nothing.

**Blast radius:** `apps/pwa/src/lib/capture/media-capture.ts` (one file), **plus one test
update**: `apps/pwa/src/report-destinations.guard.test.ts` asserts the ladder's last rung is
literally `{}` (`expect(ladder).toMatch(/\{\},\s*\n?\s*\]/)`). Once rung 3 carries `ideal`
resolution it is no longer `{}` — that assertion must be rewritten to prove "rung 3 constrains
no *camera*, only quality" rather than matching an empty object. Do not weaken the neighbouring
`facingMode` assertions.

### ACCEPTANCE A

- `[L]` Real device, Visible skin, ≥60 s alert: `chunks_index` shows one chunk per second with
  **`sizeBytes` ≲ 200 KB each** — verified with the query in §Proof.
- `[L]` The capture is still from the **rear** lens (visually confirm the recording shows the
  scene, not the survivor).
- `[L]` A device with no rear camera still records video (ladder intact, rung 2 or 3 serves it).
- `[L]` A device with no camera at all still records audio + location (rung 4 intact).
- `[A]` `grep` proves no `exact` on `width`/`height`/`frameRate`, and the `facingMode` lines are
  unchanged from `0922bd9`.
- `[A]` Trigger path still free of any auth/entitlement/network check (existing guard holds).

---

## ITEM B — LIFE-SAFETY PRIORITY QUEUE (the one that matters most)

**The coordinator's SITUATION summary is empty because 1.5 MB video chunks are standing in front
of 300-byte classifications in a single-file queue. A coordinator who cannot see the situation
cannot act on it.**

- `[A]` Split the queue into two lanes, derived **in memory** from `item.kind` — no schema change,
  no device-DB migration:
  - **SIGNAL** (small JSON, life-safety): `locations`, `classifications`, `transcripts`, `origin`.
  - **BULK** (bytes): `chunks`.
- `[A]` Every drain pass services **SIGNAL to completion first**, then BULK. A BULK failure or
  backoff must never delay the next SIGNAL pass — the `return` at `upload-manager.ts:482` must no
  longer be able to strand the SIGNAL lane.
- `[A]` **Chunk order is preserved strictly within BULK.** Assembly depends on ascending,
  contiguous sequence, so the BULK lane still stops at its first failure. That stop must be
  scoped to the lane, not the pass.
- `[A]` Within SIGNAL, one item's failure must not block the others: per-item backoff, skip and
  continue.
- `[A]` **Nothing is ever dropped, reordered out of its lane, or discarded to make room.** Queue
  depth decreases only on a 2xx. Capture retention is never traded for throughput.
- `[A]` SIGNAL gets its own short retry cadence, independent of BULK's backoff (which reaches
  30 s). A 30 s bulk backoff must not become a 30 s SITUATION blackout.
- `[A]` Offline behaviour unchanged: the `navigator.onLine` check and the resume-on-reconnect
  path stay as they are.
- `[A]` Single-flight overall is retained (no parallel upload storms). The change is *ordering*,
  not concurrency.
- `[A]` Touches no capture, trigger, closure, or classifier code. The classifier's 5 s cadence is
  not altered — only whether its output can leave the device.

**Blast radius:** `apps/pwa/src/lib/upload/upload-manager.ts` (`drainQueue` + a lane predicate).
One file. `lib/storage` is deliberately **not** touched — the lane is derived from `kind`, so
there is no queued-record migration and no risk to items already queued on a device.

### ACCEPTANCE B

- `[L]` Real device, ≥90 s Visible alert **on mobile data** (not Wi-Fi): the coordinator view
  shows a **populated SITUATION block within ~15 s of trigger**, and it keeps updating for the
  life of the event.
- `[L]` `classifications_index` for that event holds **≥ 0.8 × (duration ÷ 5)** rows; locations
  are non-trivial; transcripts present if anything was said.
- `[A]` `chunks_index` sequences remain **contiguous and ascending** — no gaps, no reordering.
- `[L]` **Adversarial:** force a slow or interrupted uplink mid-session (airplane mode for ~30 s,
  or a throttled profile). SITUATION still populates once connectivity returns, **no queued item
  is lost**, and chunk order is still contiguous afterwards.
- `[L]` A bulk chunk stuck in 30 s backoff does **not** delay classifications — prove by
  timestamp ordering in D1 (classification rows landing while chunk sequence is stalled).

---

## ITEM C — PLAYBACK / ASSEMBLY (shared, honest about the format)

**Independent `MediaRecorder` segments are separate media files. There is no correct way to play
them as one stream by byte-concatenation, and the system currently pretends otherwise in two
places.**

- `[A]` **Sequential segment playback is the shipped approach.** The player consumes an ordered
  segment list and plays segment 0, then 1, then 2… advancing on `ended`. No remux, no format
  change, works on iOS Safari and Android Chrome. Accepted trade-off: cross-segment seeking is
  approximate and there may be sub-frame joins — a coordinator seeing the *whole* recording with
  imperfect scrubbing beats seeing one second of it.
- `[A]` **No byte-concatenation is ever handed to a media element as a single file.** Either
  retire that use of `/audio/full` for playback or restrict it to non-playback use (e.g. export),
  and say plainly in the code which it is.
- `[A]` `normMime` must never report a codec the bytes are not. Pass through the recorder's actual
  reported type; add the missing `vp09` and `video/mp4` handling. A type it cannot vouch for must
  fall back to sequential playback, not to a guess.
- `[A]` **One algorithm, two call sites, no drift.** The ordered-segment contract
  (`{ sequence, mimeType, source }`, ascending, gapless advance) is defined once in
  `packages/shared` with its own unit test. Both players conform to it:
  - `workers/api/src/dashboard/page.ts` — the coordinator view (camera element at `:699`, audio
    at `:740`). These are the **only two** `/audio/full` consumers; `recipient-page.ts` and
    `cad-summary.ts` are untouched.
  - `apps/pwa/src/lib/report/playback.ts` — Evidence Review. Replace the single
    `new Blob(parts)` with the ordered per-segment list. `revokeReview` must release **every**
    segment URL, not just one.
- `[A]` **No new server endpoint is required.** `/v1/c/:id/audio/:sequence` already exists
  (`index.ts:1451`) and `/audio/stream` (SSE, `:1435`) already announces new chunks, so a live
  playlist can extend during an active event.
- `[A]` The honest-status rules hold: a segment that will not open is reported, never silently
  skipped — Evidence Review already counts unopenable segments and must keep doing so.
- `[A]` Duration shown must be the true total across segments, never `00:00` and never one
  segment's length.

**Deferred alternatives, named with their cost (not chosen now):**
- **C2 — server-side remux** into one valid container. Correct output and true seeking, but puts a
  remuxer in the Worker: real dependency, CPU and size budget, new failure mode on the coordinator
  path. Revisit only if approximate seeking proves inadequate in the field.
- **C3 — record fragmented output** so segments concatenate natively. Cleanest result, but it is a
  capture-path and container change — barred by §0 DO NOT TOUCH, and not worth the safety-floor
  risk for a playback problem.

**Blast radius:** `packages/shared` (new segment-playlist contract + test),
`workers/api/src/dashboard/page.ts`, `apps/pwa/src/lib/report/playback.ts`. Worker route code
unchanged.

### ACCEPTANCE C

- `[L]` A real-device capture of **≥60 s plays end to end** on the coordinator dashboard — video
  and audio — on **iOS Safari AND Android Chrome**. Not 1 s, not one segment.
- `[L]` The displayed duration matches the real recording length.
- `[L]` Evidence Review (a build with `VITE_ENVELOPE_ENC=true` — the flag-on branches are
  tree-shaken from a normal prod build) plays the whole recording, and closing the screen releases
  every segment URL.
- `[A]` No media element anywhere is given a byte-concatenation as one file.
- `[A]` `normMime` reports only types it can vouch for; `vp09` and `video/mp4` are handled.
- `[L]` A capture containing a deliberately corrupted segment still plays the others, and the
  unopenable one is reported honestly.
- `[A]` Provable against an existing event with ≥4 chunks, so C does not depend on A or B landing
  first.

---

## §Proof — THE QUERIES (read-only, prod)

```sql
-- A: chunk cadence and size. Expect ~1 row/second, sizeBytes ≲ 200 KB.
SELECT sequence, sizeBytes, mimeType, createdAt
FROM chunks_index WHERE eventId = ? ORDER BY sequence;

-- B: is the life-safety signal getting through? classifs should be ≈ duration/5.
SELECT e.id,
  (SELECT COUNT(*) FROM chunks_index         c WHERE c.eventId = e.id) AS chunks,
  (SELECT COUNT(*) FROM locations_index      l WHERE l.eventId = e.id) AS locs,
  (SELECT COUNT(*) FROM classifications_index k WHERE k.eventId = e.id) AS classifs,
  (SELECT COUNT(*) FROM transcripts_index    t WHERE t.eventId = e.id) AS transcripts,
  (e.securedAt - e.createdAt)/1000 AS dur_s
FROM events e ORDER BY e.createdAt DESC LIMIT 8;

-- B: contiguity — hi - lo + 1 must equal chunks.
SELECT eventId, COUNT(*) AS chunks, MIN(sequence) AS lo, MAX(sequence) AS hi
FROM chunks_index GROUP BY eventId ORDER BY MAX(createdAt) DESC LIMIT 5;
```

## COMBINED FINAL PROOF (after all three)

- `[L]` One real-device Visible alert, ≥2 minutes, on mobile data:
  1. **Continuous capture** — `chunks_index` holds ~1 chunk/second for the full duration,
     contiguous, each ≲200 KB.
  2. **SITUATION populates on the coordinator view** within ~15 s and keeps updating to the end.
  3. **Full playback** — the coordinator plays the entire recording end to end; Evidence Review
     does the same on a flag-on build.
- `[A]` §0a Hidden facade byte-identical. Trigger ungated and untaxed. Rear camera unchanged.
  Retention never suspended. Both halves currency-asserted. Acceptance suite green.

## REPORT

GOOD / BAD / CORRECT-FOR-REPAIR per item, root cause named, evidence per claim. State what
deploys before deploying it. Each item lands as its own commit with its own `[L]` proof, so any
one can be reverted without disturbing the other two. Every open item ends with who closes it and
how.
