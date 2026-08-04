# BRIEF 55 §A1 — DIAGNOSIS, BEFORE ANY FIX

**Read-only.** Production D1, `SELECT` only. No writes, no Worker requests, no live endpoints.
Source: the 04 AUG 26 device session against `2d3c118`.

---

## The four events of the test session

| # | Event | JST | Mode | chunks | classifications | locations | transcriptionState |
|---|---|---|---|---|---|---|---|
| 1 | `9dd89523` | 17:40:12 | — | 14 | 4 (all `unclassified`) | — | active |
| 2 | `88c088c8` | 19:57:17 | Visible | 7 | 13 | — | active |
| 3 | `75d4975f` | 19:59:05 | Visible | 5 | 9 | — | active |
| 4 | `febff13d` | **20:30:13** | **Visible** | **27** | 12 | 7 | active |
| 5 | `49be0e3f` | **20:31:46** | **Hidden** | **0** | **0** | **8** | **unavailable** |

---

## §A — WHERE THE EVIDENCE WAS LOST

### It was lost at ACQUISITION. Not at queueing, not at upload, not at storage.

The Hidden event ran for **73.8 seconds** and, during that time, **successfully uploaded 8
location fixes**. Locations travel the same authenticated path as chunks — same session token,
same origin, same network, same worker. Eight of them landed.

**A device that uploaded 8 location fixes was not failing to upload.** That eliminates the
queue, the uplink, the token, and R2 in one observation. `chunks_index` has zero rows for the
event, so nothing was ever offered to the server to store.

### The microphone was denied to that session, and we have the device's own words for it

`events.transcriptionDetail` for `49be0e3f`:

> *"Speech transcription could not access the microphone. Audio is still recording."*

That string is written by `speech-recognition.ts` only on `not-allowed`, `service-not-allowed`,
or `audio-capture` — the terminal microphone-denial errors. So the device told us, in a field
that reached the database, that **the OS refused it a microphone**.

`MediaCapture.acquireStream()`'s floor rung is `getUserMedia({ audio: true, video: false })`.
If the OS is refusing microphones to that page, that rung throws, `start()` catches, returns
`false`, and **no MediaRecorder is ever constructed**. Zero chunks is the exact expected
consequence. Nothing else in the pipeline needs to have failed, and nothing else did.

**Answer to A1's questions:** `MediaRecorder` never started. No chunk reached the queue. No chunk
reached the server. The capture was **denied outright** — it did not start and produce nothing.

### The second half of that sentence is false, and it is stored

> *"Audio is still recording."*

Audio was **not** still recording. That sentence is a hardcoded tail on the transcription
message, written on the assumption that a transcription failure is independent of a capture
failure. In the exact case where the mic is denied to the whole page, they are the *same*
failure, and the message asserts the survivor is protected at the moment she is not.

### §A2 confirmed — capture failure is silent, by construction

`activation/index.ts`:

```ts
const captureStarted = await capture.start();
if (captureStarted) {
  onRecordingStarted(newSessionId);
  ...
}
```

**There is no `else`.** When capture fails, nothing is uploaded, nothing is declared, nothing is
logged upward. The event proceeds — dispatch, cascade, heartbeat, location, closure — completely
normally. This is why it presented as a working alert.

Three separate strings then assert capture that nobody observed:

| `dashboard/page.ts` | String |
|---|---|
| :186 (server) | `No specific indicators detected yet. Audio + location active.` |
| :803 (client) | *(same string, duplicated)* |
| :315 | `...audio and location are recording.` |

All three are reached from `situation.hasSignal`, which is derived from *classification rows*.
None of them reads `audio.latestSequence` — which the server already computes and which was
`null` for this event. **The server had the disproof in hand and rendered the claim anyway.**

---

## §C — CONTENTION IS THE LIKELY CAUSE, AND THERE IS A STRUCTURAL DEFECT UNDERNEATH IT

The Visible event closed at **20:31:33**. The Hidden event was created at **20:31:46** — a
**13-second** gap. In that window the OS refused the page a microphone *and* a camera, and
refused Web Speech a microphone too. Three denials, one page, thirteen seconds after a session
that held all of them.

I cannot prove from stored data alone which holder failed to release. What the code shows is a
defect that makes the race likely and that exists on **every activation**, not just this one:

```ts
transcription.start();                        // opens Web Speech's OWN microphone
const captureStarted = await capture.start(); // THEN asks for the evidence microphone
```

**The subsystem whose output is optional acquires the microphone before the subsystem whose
output is the entire product.** Web Speech opens a second, independent capture; on iOS Safari
that acquisition is enough to make a subsequent `getUserMedia` fail. The evidence path should
never be second in that queue, and today it always is.

That ordering is a real defect regardless of whether it caused this specific loss.

---

## §D — THE BRIEF'S PREMISE IS REFUTED BY THE DATA. There are not two summarizers.

**The two readings in the brief are two different events.**

`febff13d` (20:30, the event whose Evidence Review showed `don't ×12`) has **twelve stored
classification rows, and every one of them is identical**:

```json
[{"category":"restraint","matches":["don't","dont"],"weight":3}]   threatLevel: medium
```

No weapon category. No violence category. Never above `medium`. The
*Violence · Profanity · Weapon · CRITICAL* reading belongs to **`88c088c8` (19:57)**, whose
transcript contained the literal words "gun" and "knife":

```json
[{"category":"weapon","matches":["gun","knife"],...},{"category":"violence",...},...]  critical
```

Evidence Review rendered `febff13d` **faithfully**. It computed nothing. Both surfaces read the
same table (`classifications_index`) and neither re-analyses media. **§D1 as written — "delete
the second implementation" — has no second implementation to delete, and doing what it says
would remove a correct renderer.**

### What IS wrong, and it is worse than a divergence

The transcript of `febff13d`, in full:

> *"People don't shut up I'm gonna cut your throat | You asked for this you would make me do this
> too | You're so stupid"*

- **`cut`, `throat`, `slit` appear in no dictionary in `packages/classifier`.** An explicit death
  threat matched **nothing**. `WEAPON(S): Not recorded` is a *truthful* rendering of a record
  that is genuinely silent.
- The **only** reason this event was not `unclassified` is the word **`don't`**, which the
  `restraint` category lists as a keyword. An explicit throat-cutting threat was scored
  **`medium`, on the strength of a contraction.**
- **`don't ×12 · dont ×12` is ONE word.** The transcript contains a single `don't`. The matcher
  normalises the apostrophe, so that one token matches *both* dictionary entries — that is the
  double-count. And `×12` is not twelve utterances: it is the same latched match re-recorded by
  twelve classification ticks. **One word, rendered as twenty-four dangers.**

There IS a genuine duplication, just not the one the brief names: the category label map exists
twice inside one file — `CATEGORY_LABEL` at `page.ts:112` (server render) and `SIT_LBL` at
`page.ts:799` (client render), as a string inside a template literal. Two copies that must agree
and that nothing forces to.

---

## What I propose to build, given the above

| Item | Brief says | Evidence says | Build |
|---|---|---|---|
| §A2 | Never assert unobserved capture | Confirmed, 3 strings + a stored one | **As written** |
| §A | Fix the loss | Acquisition denial | **§C fixes it; also make it loud** |
| §C | Release every track | Ordering defect found | **As written + acquire order** |
| §D1 | Delete the second summarizer | **No second summarizer exists** | **Unify the label map; Evidence Review renders category labels, not raw terms** |
| §D2 | Stopwords render nothing | One word → 24 dangers | **As written, at the render layer** |
| §D3 | Weapon threat → *Weapon reference* | **Dictionary gap, not a render bug** | **Render fix + a narrow phrase addition, flagged** |

§D3 requires touching the keyword dictionary, which was explicitly held in Brief 52 pending a
corpus with real provenance. Brief 55 acceptance 8 requires it. It is called out at the point of
change so the exception is visible rather than buried.
