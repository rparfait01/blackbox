# BRIEF — ITEM D: EVIDENCE EXPORT (verifiable ZIP) + VERIFIER EXTENSION

**The evidence-export path. Report generation and evidence accessibility CANNOT FAIL. On-device (zero-knowledge:
server never sees plaintext). Root-cause build, not a patch.**

Standing constraints apply. Restore point first. §0a Hidden byte-identical. Trigger/capture/classifier/closure
untouched. Both halves currency-asserted. Prove [L] on a real device with a 10+ minute capture.

---

## THE MODEL (locked)
| Path | Output | Export? |
|---|---|---|
| **Evidence Review (dashboard)** | On-device playback (watch/listen/review), read-only | **NO export.** Review only. |
| **Generate Official Report** | A single **verifiable ZIP** the user releases | **YES — export happens ONLY here.** |
| **Verifier** (existing, extended) | Drop a **report file OR a ZIP** → CERTIFIED / NON-CERTIFIED | Anyone checks authenticity |

**Export exists ONLY on Generate Official Report.** The Evidence Review dashboard never exports — it is review
on-device only.

## §1 — GENERATE OFFICIAL REPORT → VERIFIABLE ZIP
On generate (client-side, on-device, ZK-preserved), assemble ONE ZIP containing:
- `[A]` **Raw signed chunks** — the complete capture, every byte, always present. This is the floor.
- `[A]` **Remuxed forensic video/audio** — one seamless, frame-accurate, fully-seekable file — **if remux
  succeeds.** Optional enhancement, never a gate (see §3).
- `[A]` **Location track** — full timestamped ping history (JSON/GPX).
- `[A]` **ORIGIN snapshot** — the write-once t=0 record (trigger type, DTG, initial location, initial
  classification).
- `[A]` **SITUATION summary + human-readable report document** — the classifier-derived situation (categories,
  threat level, tone, timeline), plus the survivor's written account, Sentinel-certified.
- `[A]` **Signed manifest** — SHA-256 of EVERY file in the ZIP + the ORIGIN + Sentinel's signature. This is what
  the verifier checks.
- `[A]` **Verification note** — plain text: "Verify this package at blackbox-verify.pages.dev."

## §2 — CHAIN OF CUSTODY (court-grade)
- `[A]` The signed manifest signs the **raw chunks** as ground truth. The remuxed file is a **faithful,
  verifiable reassembly** of those chunks — NOT a separately-signed substitute.
- `[A]` If opposing counsel challenges the remux, the raw signed chunks are the authority and the remux provably
  derives from them. State this relationship in the manifest.

## §3 — CANNOT FAIL (the floor)
- `[A]` The remuxer is **bundled in the app** (ships with the PWA, on-device already). **NO download at
  report-generation time** — generating a report never depends on a network fetch.
- `[A]` **If remux fails for ANY reason** (memory, device, error): the ZIP STILL generates with raw signed
  chunks + location + manifest + report doc. Evidence is delivered; only the seamless-seek convenience file is
  absent. **Report generation degrades to raw-signed-chunk export — it NEVER fails to produce accessible
  evidence.**
- `[A]` Handle a 10+ minute / large (60MB+) capture without failing — process in a way that does not require the
  entire file in memory at once if that risks a device. Prove on a real device with a 10+ minute capture.
- `[A]` Remux runs on the report path ONLY — never the live coordinator or trigger/capture path.

## §4 — VERIFIER EXTENSION (accept a report file OR a ZIP)
The existing verifier (blackbox-verify.pages.dev) must accept BOTH:
- `[A]` A **single report file** (current behavior — keep it working).
- `[A]` A **ZIP package** — unzip, recompute SHA-256 of every contained file, compare against the signed
  manifest, verify Sentinel's signature.
- `[A]` Verdict: **CERTIFIED** (all hashes match + signature valid) / **NON-CERTIFIED / TAMPERED** (any file
  altered, missing, or signature invalid) / graceful "not a BLACK BOX package" for anything else.
- `[A]` Stays client-side, zero network calls during verification (measured, not asserted — the file/ZIP is never
  uploaded). Key-pinned against the published key (no forged-key self-verification).
- `[A]` A detective/attorney/juror drops the ZIP in and gets a definitive certified/not answer without trusting
  BLACK BOX.

## §5 — DO NOT TOUCH
- `[A]` Trigger, capture firing, the classifier, closure, config timing, rear camera — untouched.
- `[A]` Evidence Review dashboard remains review-only — this brief does not add export there.
- `[A]` Live coordinator + Evidence Review keep their fragmented playback (Item C) — remux is report-only.

## ACCEPTANCE (real device, 10+ minute capture)
- `[L]` Generate report → ZIP produced containing raw chunks + remuxed file + location + ORIGIN + report doc +
  signed manifest + verification note.
- `[L]` Remuxed video is seamless and frame-accurate; seek to an exact timestamp lands accurately.
- `[L]` Force remux to fail → ZIP still generates with raw chunks + manifest → still complete, still verifiable.
- `[L]` Drop the ZIP into the verifier → CERTIFIED; alter one file → NON-CERTIFIED/TAMPERED.
- `[L]` Drop a single report file into the verifier → still works (unchanged).
- `[L]` Remux verifies against the original signed chunks (chain of custody holds).
- `[L]` 10+ minute capture exports without failing; no memory cliff.
- `[A]` On-device only (server never sees plaintext); §0a byte-identical; trigger/capture untouched.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Real-device proof per [L], including the remux-fails-still-exports floor and the
ZIP verification. Confirm the manifest signs raw chunks and the remux verifies against them. Confirm the verifier
accepts BOTH a report file and a ZIP. Restore point id. Deployed hash, both halves asserted.
