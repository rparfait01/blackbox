# DECISION REQUIRED — LIVE VIDEO ON iOS

**For Royce. Report only; nothing here is built.**
Supersedes §2 of `BRIEF_055_DEVICE_TEST_2_FINDINGS.md`, which was written before the codec fix
landed and is now partly out of date.

---

## WHAT CHANGED SINCE THE LAST REPORT — one of the two blockers is gone

The last report named two independent blockers. **The first is fixed and confirmed on your
device.**

`pickMimeType` offered `video/mp4;codecs=h264,mp4a.40.2` as its first candidate. `h264` is the
WebRTC-style name, not an ISO BMFF codec identifier, so `MediaRecorder.isTypeSupported` answered
false even on a build that records H.264/MP4 perfectly well — and the ladder fell straight through
to WebM/VP9. **WebKit cannot decode VP9 and does not read the WebM container at all**, so every
capture in production was unplayable on an iPhone, live or on replay.

Shipped in `fefb037` with proper `avc1.*` identifiers. The two events from your 05 AUG 10:45 test:

```
b610d0df   5 chunks   video/mp4; codecs=avc1.42000a,mp4a.40.2
3ec662d2   7 chunks   video/mp4; codecs=avc1.42000a,mp4a.40.2
```

Real H.264 in MP4. Not one WebM chunk. **Replay on iOS now works.** The remaining question is only
about LIVE.

---

## THE REMAINING CONSTRAINT, PRECISELY

Classic Media Source Extensions is **not exposed on iPhone Safari**. Our dashboard checks
`window.MediaSource`, finds nothing, and falls back to download-to-play. That fallback is honest
and it now actually plays — but it is not live.

Three ways to close that, and only three.

| | Latency | iOS Safari | What it costs |
|---|---|---|---|
| **A. LL-HLS** | ~2–6s | **Native. No JS at all.** | The Worker must repackage incoming chunks into fMP4 segments plus a rolling playlist. Our chunks are independent MediaRecorder slices, not fMP4 with an init segment, so this is real remuxing work in the Worker. Input is already H.264/AAC, so no transcoding is needed — that is what the codec fix bought. |
| **B. ManagedMediaSource** | ~1–3s | iOS 17.1+ only | Closest to the current design: keeps the chunk transport, swaps the MSE call. Least work of the three. Cuts off anyone on older iOS, silently, and we have no data on what your users run. |
| **C. WebRTC** (Cloudflare Realtime SFU) | **sub-second** | Yes | A **second transport**, not a replacement. It retains nothing, so the chunk upload must continue in parallel — and the phone maintains a live peer connection, which is battery and a new failure mode on the alert path. |

### The thing that makes C not a drop-in

Store-and-forward is why evidence survives a bad network. Chunks queue on the device and retry;
a survivor in a stairwell with one bar still ends up with a complete recording. WebRTC is
real-time and lossy by design — it drops what it cannot deliver now.

So WebRTC can only ever be **additional**. It would give a coordinator a sub-second view while the
existing pipeline keeps producing the evidence. That is a coherent design, and it is roughly twice
the moving parts on the survivor's phone during an incident.

---

## WHAT I THINK, SINCE YOU ASKED FOR THE REAL CONSTRAINT

**"Live" is probably not the requirement.** The coordinator's decision is *do I send help* — and
video five seconds behind answers that exactly as well as video half a second behind. What
actually changed the answer in your device tests was not latency; it was that the panel was blank
or the codec was undecodable.

If that is right, **A (LL-HLS) is the answer**: native on iOS, no JavaScript in the playback path,
no second transport on the phone, and the input format is already correct. The cost is Worker-side
remuxing, which is bounded, testable work that touches nothing on the survivor's device.

**B is the cheap option** and I would take it only as a stopgap, because it silently excludes
older iOS and we cannot see who that is.

**C is right only if sub-second genuinely matters** — for example if a coordinator is expected to
talk a survivor through something in real time. That is a product question about what the
coordinator is *for*, and it is yours, not mine.

---

## WHAT WOULD MAKE THIS DECIDABLE ON EVIDENCE RATHER THAN JUDGEMENT

Two cheap things, in order:

1. **Confirm playback on the coordinator's actual iPhone.** The codec fix is confirmed at the
   recording end from the database. Nobody has yet watched one of those MP4 captures play back on
   an iOS device. That is one tap and it either works or it does not.
2. **Report three values once, from the coordinator page**: `typeof MediaSource`,
   `typeof ManagedMediaSource`, and `canPlayType('video/mp4; codecs=avc1.42000a')`. That replaces
   every "should" above with a fact about the device your coordinators actually hold, and it
   decides between A and B without a spike.

Neither costs anything and both are quicker than the argument.

---

## WHAT IS NOT AT ISSUE

- Recording. It works, on both platforms, in a format WebKit can decode.
- Replay. Works now.
- Honesty of the current fallback. It says what it is and it plays.
- The survivor's device. Nothing in this decision changes what happens during an incident, unless
  you choose C.
