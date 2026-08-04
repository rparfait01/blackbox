# DEVICE TEST 2 — THREE UNSAT ITEMS, DIAGNOSED. REPORT ONLY, NOTHING FIXED.

Read-only against production D1 and the repo. 05 AUG 26.

---

## 0. WHAT THE DATA SAYS ABOUT THE TEST DEVICES, BEFORE ANYTHING ELSE

This reframes items 1 and 2, so it comes first.

| Event | JST | transcription | chunks | recorded format | device |
|---|---|---|---|---|---|
| `2de8ccf1` | **08-05 05:12** | **unavailable** | 5 | `video/webm; codecs=vp09.00.10.08,opus` | **Chromium** |
| `e3a4e073` | **08-05 05:09** | **unavailable** | 8 | `video/webm; codecs=vp09.00.10.08,opus` | **Chromium** |
| `49be0e3f` | 08-04 20:31 | unavailable | 0 | — | (denied) |
| `febff13d` | 08-04 20:30 | active | 27 | `video/webm; vp09` | Chromium |
| `75d4975f` | 08-04 19:59 | active | 5 | `video/webm; vp09` | Chromium |
| `88c088c8` | 08-04 19:57 | active | 7 | `audio/mp4; mp4a.40.2` | **WebKit/iOS** |
| `9682bd4d` | 08-04 19:56 | unavailable | 4 | `video/webm; vp09` | Chromium |
| `26998dc8` | 08-04 17:45 | unavailable | 3 | `audio/mp4` | WebKit/iOS |
| `9dd89523` | 08-04 17:40 | active | 14 | `video/webm; vp09` | Chromium |

**The device that records video is not an iPhone.** WebKit's MediaRecorder cannot produce WebM in
any container, and `vp09.00.10.08` is Chromium's codec string. Every video capture in the entire
production history is WebM/VP9; **there is not one `video/mp4` chunk anywhere.** The `audio/mp4`
events are the iOS device, and on those, video acquisition failed — `pickMimeType` only returns an
`audio/*` type when the acquired stream carried no video track.

So the test spans two devices, and the item-1 failure is on the **Chromium** one.

---

## 1. WHY WEB SPEECH IS DENIED — AND IT IS ALMOST CERTAINLY MINE

**Direct answer to the question asked: no, this is not the second acquisition failing by design on
iOS. The device it failed on is not iOS, and it is not a contention failure either.**

### The before/after split

| Build | Events | transcription |
|---|---|---|
| Before Brief 55 | `9dd89523`, `75d4975f`, `febff13d`, `88c088c8` | **active** (4 of 6) |
| **After Brief 55** | `e3a4e073`, `2de8ccf1` | **unavailable (2 of 2)** |

Both post-Brief-55 events captured successfully — 8 and 5 video chunks — so the microphone and
camera were both granted to `getUserMedia`. Only Web Speech was refused. On the same device, on
the previous build, it worked.

### The mechanism, and it is in the diff I shipped

`triggerAlert` carries this comment, written long before Brief 55, about a *different* call:

> *"…first statement, before any `await`, so it runs while the tap's user-gesture context is still
> valid (**Chrome drops the gesture after awaits**)."*

Brief 55 §C moved `transcription.start()` from **above** `capture.start()` to **below** it:

```ts
const captureStarted = await startCaptureWithRetry(capture);   // <-- awaits getUserMedia
...
transcription.start();                                          // <-- now outside the gesture
```

`SpeechRecognition.start()` requires a live user-activation on Chromium. It previously ran before
that `await` and inherited the tap. It now runs after an `await` on a permission prompt — the
gesture is spent — and Chromium answers `not-allowed`, which `speech-recognition.ts` maps to
exactly the message that reached the database.

**I traded transcription for capture ordering without noticing the two requirements were in
conflict.** §C's ordering rule is still right — the evidence microphone must be requested first —
but I implemented it by moving a call across an `await`, which changed a second property nobody
was tracking.

### The shape of the fix (not applied)

The two requirements are only in conflict because I used `await` as the ordering mechanism.
Issuing `capture.start()` **without awaiting it**, then calling `transcription.start()` on the very
next synchronous line, puts **both** acquisitions inside the tap's gesture *and* keeps capture's
request strictly first. The `await` then moves to where the result is actually needed. That
satisfies §C and the standing constraint without costing the transcript.

Two caveats I cannot resolve from here:

- **The pre-Brief-55 record was already 2-of-6 failing** (`9682bd4d`, `26998dc8`). So a second,
  older cause exists underneath this one and the gesture fix will not necessarily clear it.
- **`speech-recognition.ts` collapses three distinct errors into one message.** `not-allowed`
  (no gesture / permission), `service-not-allowed` (the speech *service* is unavailable — the
  usual answer in an installed iOS PWA), and `audio-capture` (no microphone) have different causes
  and different fixes, and we store none of them. **We cannot currently tell these apart from the
  record**, which is why the paragraph above says "almost certainly" rather than "is". Recording
  `event.error` verbatim is a one-line change and would make the next test conclusive.

---

## 2. LIVE VIDEO ON iOS SAFARI — ACHIEVABLE, BUT NOT ON THIS TRANSPORT

### First, a correction to my own Brief 55 §B

I shipped an honest fallback with a working "Play recording so far" button. **For these captures,
on iOS Safari, that button cannot work either.** `/audio/full` serves the stored bytes with the
stored MIME type — `video/webm; codecs=vp09` — and **WebKit does not decode VP9, and does not
support the WebM container at all.** Not via MSE, not via ManagedMediaSource, not natively.

The honest message is still an improvement over an empty 00:00 player. But "honest but not live"
is more optimistic than the truth: for a Chromium-recorded event viewed on iOS Safari, it is
**honest and not playable**.

### So there are two independent blockers, not one

1. **Codec/container.** iOS Safari plays H.264/AAC in MP4 (and HEVC), and HLS. It plays nothing
   we currently record from the Chromium device. This blocks live *and* replay, and it is the
   bigger of the two.
2. **Live transport.** Classic MSE is not exposed on iPhone Safari. Apple's replacement is
   `ManagedMediaSource` (Safari 17.1+); the platform-native path is HLS.

### What would actually make it live

| Path | Latency | iOS Safari | What it costs |
|---|---|---|---|
| **LL-HLS** | ~2–6s | **native, no JS** | Worker packages incoming chunks into fMP4 segments + a rolling playlist. **Requires H.264/AAC input.** Our chunks are independent MediaRecorder slices, not fMP4 with an init segment — this is real remuxing work, and it cannot be done on VP9 without transcoding, which Workers cannot do. |
| **ManagedMediaSource** | ~1–3s | iOS 17.1+ only | Closest to the current design — keeps the chunk transport. Still needs decodable codecs, so it does not help until (1) is solved. Cuts off older iOS. |
| **WebRTC** (Cloudflare Realtime SFU) | **sub-second** | yes | Codec negotiated, so H.264 is available regardless of what MediaRecorder prefers. But it is a **live-only** path: it retains nothing. It must be ADDITIONAL to the chunk upload, not a replacement — the store-and-forward design is what makes evidence survive a bad network, and that property is not negotiable. Also a persistent connection from the survivor's phone, which is battery and a new failure mode. |

### The answer to "is it achievable at all in a PWA"

**Yes.** Nothing about the PWA sandbox blocks any of the three. The constraint is not the capture
side at all — it is the **viewer's** browser and the codec we hand it. The survivor's phone already
holds the bytes and already uploads them.

### The cheapest real improvement, before choosing any of that

Make the recorder produce something iOS can decode. `pickMimeType` already tries
`video/mp4;codecs=h264,mp4a.40.2` **first** and the Chromium device refused it, falling through to
WebM. Whether that refusal is genuine or a `isTypeSupported` quirk on that specific build is worth
five minutes with a real device — if H.264/MP4 recording is available there, replay on iOS starts
working immediately with no architecture change, and LL-HLS becomes possible later.

### The product decision, stated plainly

**"Live" may not be the requirement.** A coordinator deciding whether to send help is served
equally by video 5 seconds behind. LL-HLS gets that and is native on iOS. Sub-second needs WebRTC
and a second transport. That is the real trade in front of you — it is not live-vs-nothing.

### One instrument worth building first

We are reasoning about the viewer's browser from a distance. Three values reported once from the
coordinator page — `typeof MediaSource`, `typeof ManagedMediaSource`, and `canPlayType` for the
formats we store — would replace every "should" in this section with a fact. Cheap, and it means
the next decision is made on data.

---

## 3. DURESS — CONFIRMED, AND IT IS WORSE THAN "A DEFAULT"

### What sets DURESS

One thing only. The dashboard renders `var duress = cl.pin==='unsat'`, `pin` comes from
`events.closeRequestStatus`, and that column is written in exactly one place —
`recordUserAssent()` — from the `status` field of `POST /v1/events/:id/closure-request`.

**The server has no default.** A missing `status` is a 400. A never-requested closure leaves the
column NULL, which renders as SAT, not DURESS. The acceptance suite posts `sat` and it is handled
correctly. **Nothing server-side invents this.**

The client sets it here, in `ClosureControl.tsx`:

```ts
onPointerUp() {
  if (startRef.current === null) return;
  const elapsed = performance.now() - startRef.current;
  stopRaf();
  if (!firedRef.current && elapsed < HOLD_MS) void submit(false);   // <-- DURESS
}
```

`HOLD_MS = 3000`. **Any release before 3.000s is duress**, and the code says so deliberately:
*"No dead zone: any early release is UNSAT."*

### It is not merely the default — it is the ONLY outcome that has ever occurred

```
closeRequestStatus   count   first        last
unsat                  16    2026-07-26   2026-08-04
```

Sixteen events. Sixteen `unsat`. **Zero `sat`, ever, since the production reset.** The audit table
agrees exactly: 16 × `user_assent_duress`, 0 × `user_assent`. One POST per closure — so this is not
a double-fire overwriting a good value. `submit(true)` has never executed on a real device.

**Your reading is correct and it is stronger than you put it: this is not a duress signal that
sometimes misfires. It is a duress signal that has never once NOT fired.** Every alert this system
has closed in production carries "she is being forced to close this" in the record, and the
coordinator email path for duress is titled *"⚠ DURESS — DO NOT APPROVE"*.

### Three separate defects, in order of severity

**(a) A browser-initiated cancel is recorded as a human being coerced.**

```jsx
onPointerUp={onPointerUp}
onPointerLeave={onPointerUp}
onPointerCancel={onPointerUp}
```

All three route to the same handler, and that handler's only branch is "early release ⇒ duress".
`pointercancel` is not a gesture — it is the browser taking the pointer away (a system gesture, a
scroll heuristic, a call arriving). `pointerleave` is not a gesture either. **Neither is the
survivor doing anything, and both are recorded as her signalling that she is under coercion.**
There is no code path in which a cancel means anything else.

**(b) There is no pointer capture on the hold.**

The button never calls `setPointerCapture`. This is the same class as the Brief 15 defect that
made the covert trigger dead — *"a missing setPointerCapture on the hold"* — on a different
control. Without it, a finger drifting outside the 160px circle during a 3-second hold ends the
gesture, and by (a) that ends it as duress.

**(c) By design, the survivor can never discover any of this.**

The §E2 anti-coercion invariant is that both gestures produce an identical screen, so an onlooker
learns nothing. That is correct and must stay. But it also means a survivor who has sent sixteen
duress signals has received sixteen identical confirmations, and **the only surface where the
difference is visible is the coordinator's** — which is exactly where you found it, and only
because you were looking at both ends.

The progress ring is the only feedback, it is `opacity: pressing ? 1 : 0` and clipped by
`inset((1-progress)*100% 0 0 0)`, so for the first second of a three-second hold it is very nearly
invisible. A user with no dead zone, no completion signal they can trust, and no post-hoc
difference on screen has no way to learn the gesture.

### What this means for the closure model

The dual-consent flow you tested as SAT genuinely works — `decideConsent` never reads sat vs unsat,
which is why closure succeeded every time despite this. The damage is entirely to the **signal**:
duress currently carries zero information, and a coordinator who learns to ignore it has learned
the correct response to the data they have been given.

Fixing it is a design question I have not touched, and it has at least these parts: what a
`pointercancel` should mean when it is not a human action; whether "hold to close" should have a
completion signal the survivor can rely on; and whether duress should be an affirmative gesture
rather than the residue of failing to complete a different one.

---

## SUMMARY

| # | Verdict |
|---|---|
| 1 | **Regression I introduced in Brief 55 §C.** Not iOS, not contention — the failing device is Chromium, and moving `transcription.start()` below an `await` spent the user-gesture context Chromium requires. A second, older cause also exists (2 of 6 failed before), and we cannot separate the three Web Speech error codes because we discard them. |
| 2 | **Two blockers, and the codec one is bigger than the transport one.** Every video capture in production is VP9/WebM, which WebKit cannot decode at all — so on iOS these events are not merely un-live, they are unplayable, including through the fallback I shipped. Live to iOS is achievable via LL-HLS (native, ~2–6s) or WebRTC (sub-second, live-only, additional transport), both of which require decodable input first. |
| 3 | **Confirmed, and it has never once not fired.** 16/16 closures in production history are duress; `sat` has never been recorded. Any release under 3.000s is duress with no dead zone, and `pointercancel`/`pointerleave` — which are not human actions — are wired to the same branch. There is no pointer capture on the hold, and the anti-coercion design makes it undiscoverable from the survivor's side. |
