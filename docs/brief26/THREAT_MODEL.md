# Brief 26 — Zero-Knowledge Custody: THREAT MODEL

**Status:** Draft for the §5 pre-production gates. This is deliverable #1 of the brief
("Threat model written first"). **No production crypto ships until an independent crypto
reviewer and a legal chain-of-custody reviewer have signed off on this and the companion
[ENVELOPE_DESIGN.md](./ENVELOPE_DESIGN.md).**

This document states what we are protecting, from whom, what the design does **not**
protect (and why that is deliberate), and the failure modes that outrank the encryption
goal itself. It grounds every claim in the current system as read from code, so the
reviewer can check it against reality rather than aspiration.

---

## 0. The paramount non-goal (read this first)

**Capture availability outranks capture confidentiality.** A survivor mid-event must get
their capture recorded — during migration, behind the flag, in every failure mode. If
encryption and recording ever conflict, recording wins. The single worst outcome in this
whole brief is *a survivor's evidence lost forever*, and it is worse than *the operator
being able to read a blob*. Every mitigation below is subordinate to this.

Concretely: the encryption path is a strict **no-op** until a flag is armed, the flag is
armed only on test accounts first, and any client-side crypto failure **falls back to the
current (working) plaintext upload** rather than dropping the capture. See ENVELOPE_DESIGN
§"Fail-open on the capture path".

---

## 1. Assets, ranked

| # | Asset | Why it matters | Current state (from code) |
|---|---|---|---|
| A1 | **The survivor's capture availability** | Evidence of an incident; often the only record. Losing it is irreversible harm. | Plaintext chunks in R2 `MEDIA`, uploaded via a resilient IndexedDB queue (`upload-manager.ts`). Works today. |
| A2 | **Capture confidentiality** (audio/video content) | Content is the survivor's, never a BLACK BOX asset. "Storage access = blobs I cannot open." | **NOT protected today** — chunks are plaintext in R2; the operator can open them. This brief closes that. |
| A3 | **Chain-of-custody integrity** | Evidence must be provably un-tampered for the courts lane. | Append-only Ed25519-signed hash chain (`integrity.ts`), content-agnostic. **Review correction:** the chain must also commit to a **signed pre-encryption plaintext hash** per chunk — hashing only the ciphertext authenticates the wrong artifact under FRE 901 (see §4a of the design). |
| A4 | **Location confidentiality** | Reveals where the survivor is/was. | Plaintext in D1 `locations_index`, **read and processed by the server** for the live dashboard. §4B: wrap to org (design choice with real latency cost — see below). |
| A5 | **Contact-graph confidentiality** | Who the survivor's people are. | Plaintext in D1. §4B: wrap. Out of Phase 1. |
| A6 | **Private keys** (survivor, org) | Compromise = decrypt everything they can reach. | Do not exist yet. Must be **client-custodied, never server-readable.** |

**Explicitly NOT an asset to protect by encryption (the ZK boundary, §4B):** event
**timing and lifecycle state** (created/active/closed, heartbeat times, cascade step).
The operator reads these **by design**, because closure consent and the dark+unclaimed
auto-close backstop depend on them (`closure-timeout.ts`, `closure-consent.ts`). Making
them opaque would break the safety backstop that stops a survivor's event from hanging
open. **The disclosure must say this plainly** — we protect *what happened* (content) and
*where* (location), not *that/when* an event occurred.

---

## 2. Actors and trust boundaries

| Actor | Trusted with | NOT trusted with | Boundary |
|---|---|---|---|
| **Survivor's device** | Its own private key; transient plaintext of its own captures | — | The one fully-trusted zone. Keys generated and custodied here. |
| **Elected coordinator's device** (a seat) | The org private key *while operating*; transient plaintext during states 5/6/7 | Standing/offline copies; distributing evidence | Trusted *in the moment, audited*. A departed seat must lose this (state 8). |
| **Operator / server (Cloudflare Worker + D1 + R2)** | Ciphertext, integrity hash, wrapped keys, timing/state metadata | Any readable key; any plaintext content; any DEK in clear | **The zero-knowledge boundary.** This is the actor the whole brief distrusts. |
| **Authorities / courts** | Evidence re-encrypted to their key, per release, logged | A standing copy; unlogged access | Reached only via survivor-authorized release (state 7). |

**The core claim to be made structurally true:** *the operator holds blobs it cannot
open.* Everything server-side is either ciphertext, a hash of ciphertext, a wrapped key
(itself ciphertext), or non-content metadata (timing/state). No code path server-side
performs a decrypt or holds a readable key.

---

## 3. Adversaries and capabilities

| Adversary | Capability assumed | Goal |
|---|---|---|
| **AD1 — Compromised/curious operator or storage** | Full read of R2 + D1 + worker env vars/secrets | Read incident content |
| **AD2 — Departed coordinator** | Previously held the org key; may have cached it | Read captures after offboarding |
| **AD3 — Malicious org insider (active seat)** | Legitimately holds the org operating key | Exfiltrate/distribute beyond operating |
| **AD4 — Network / email-scanner** | Sees traffic, hits links (the passive-GET class) | Intercept content or keys in transit |
| **AD5 — Abuser with the survivor's unlocked device** | Physical device access | Read the survivor's own captures |
| **AD6 — Court adversary (defense counsel)** | Challenges admissibility | Get evidence excluded on custody grounds |

---

## 4. Threats × mitigations (by boundary)

**T1 — Operator reads content (AD1).** *Mitigation:* content encrypted on-device before
upload with a per-capture DEK; the DEK is stored only wrapped to survivor+org public keys;
private keys never reach the server. **Verifiable:** the acceptance suite proves the
server, holding only what R2+D1 contain, cannot produce plaintext. Residual: timing/state
metadata is readable by design (§1).

**T2 — Departed seat still decrypts (AD2).** *Mitigation:* state 8 — offboarding rotates
the org keypair and **re-wraps** prior captures' DEKs to the new org key; the departed
seat's cached key no longer unwraps anything. **This is required, not optional; a departed
seat retaining access is a failure.** Residual: content the departed seat *already
decrypted and copied* during legitimate operation is outside crypto's reach — bounded by
audit + watermark + the DPA (see T4).

**T3 — Key in transit / at rest on the server (AD1, AD4).** *Mitigation:* only *wrapped*
DEKs and *public* keys ever transit to or rest on the server. A wrapped DEK is ciphertext
under a public key whose private half is client-only. Signing already covers ciphertext
bytes (`hmac.ts` signs the body), so encrypt-then-sign is natural.

**T4 — Authorized seat exfiltrates during operation (AD3).** *Crypto cannot prevent this*
— an operating seat legitimately sees plaintext. *Mitigation is the second layer:* every
decrypt is **audit-logged** (`audit(env, eventId, 'decrypt', actorHash, {...})`), and every
capture is **watermarked** with account/org/seat id so a leak traces to a seat; the DPA
governs what a seat may *do* with what it saw. **Honesty requirement:** the disclosure must
not claim crypto stops an authorized insider — it bounds and traces them.

**T5 — Release becomes an uncontrolled copy (AD6, AD3).** *Mitigation:* release (state 7)
is a **re-encryption to the named recipient's key**, recorded as a logged key-provisioning
event (reusing `exportPackage` + `custody_transfers` + the Ed25519 manifest), never a
download-and-forward. No standing copy is created; each recipient's access is a distinct,
logged grant. **The signed pre-encryption plaintext commitment (A3, design §4a) is what
preserves chain of custody across re-encryption** — re-encryption then changes only the
container, and a later decryption is checkable against a capture-time commitment. Legal gate
owns admissibility — perfect crypto ≠ admissible evidence.

**T8 — Harvest-now-decrypt-later (AD1, long horizon).** Captures may need confidentiality for
years; a stored ciphertext copy could be broken by future cryptanalysis (incl. quantum).
*Mitigation (roadmap, not pilot):* the per-wrap algorithm identifier reserves the seam for a
hybrid ECDH + ML-KEM wrap. Flagged for the reviewer as a roadmap decision, not a pilot
blocker.

**T6 — Abuser with the survivor's device (AD5).** *Partially out of scope of crypto* — a
key on an unlocked device is reachable. *Mitigation is existing:* the covert facade (§0a)
and the device's own lock. The ZK design must not *worsen* this (e.g. by caching the org
key on a survivor device). Residual, accepted, disclosed.

**T7 — Survivor loses the key (availability, not confidentiality).** *Mitigation (§4A):*
org-enrolled survivors get **org-mediated re-provision** (the org already holds an
operating key — no new custody cost); individual survivors have **the recovery code only**,
and **lose the device + the code = gone**, stated plainly at setup. This is a deliberate
trade of ZK purity for availability for the org case, and of availability for purity in the
individual case.

---

## 5. Failure modes, ranked (the three severe outcomes from §5)

1. **Survivor's evidence lost forever** (availability). *Highest severity.* Caused by:
   crypto failure dropping a capture, key loss with no recovery, a migration bug on the
   capture path. *Guard:* fail-open on capture, flag-gated rollout, new-captures-only (§4C),
   test-accounts-first. **This outranks confidentiality.**
2. **The zero-knowledge claim is false** (confidentiality). Caused by: a readable key
   reaching the server, a DEK stored in clear, a decrypt path server-side, or a metadata
   leak beyond the disclosed boundary. *Guard:* the "prove the server cannot decrypt"
   acceptance test + the independent crypto review.
3. **A coordinator cannot decrypt to run a live response** (operability). Caused by: key
   not delivered to the elected seat in time, decrypt latency, the `/audio/full`
   concatenation incompatibility. *Guard:* Phase-2 latency bound + key-delivery design +
   replacing server-side concat with client-side per-chunk decrypt (ENVELOPE_DESIGN).

---

## 6. Non-regression invariant (capture path)

The capture → queue → upload → store → live-read path (`media-capture.ts`,
`upload-manager.ts`, `POST /v1/events/:id/chunks/:seq`, the dashboard MSE loop) **must be
byte-for-byte unchanged when the flag is OFF**, and must preserve, when ON: the
IndexedDB-backed offline queue, exponential backoff, order-preservation, launch-resume,
and single-flighted event-open. Any change that could drop or reorder a chunk is a
release-blocking regression regardless of its encryption benefit.

---

## 7. Interactions with shipped briefs (called out by the operator)

- **Tally (Brief 25) stays severed.** The `incident_tally` store has no identity and no
  join path. This brief must **create no foreign key, join, or derivation** between custody
  and the tally. The envelope custody touches events/captures only; it never references
  `incident_tally`. (Guard-tested severance from Brief 25 must remain green.)
- **Coordinator live decrypt must not slow response (Brief 23 §5).** Per-chunk AEAD decrypt
  is sub-millisecond vs the 1s SSE / 3s poll cadence — negligible. The real work is key
  delivery + the `/audio/full` obstacle, addressed in the design, not a latency problem.
- **Seat offboarding → rotation (Brief 24 interaction).** Brief 24's `leaveOrg` /
  admin-removal is the trigger for state 8: offboarding a seat must drive org-key rotation +
  re-wrap. The design wires state 8 to that existing offboarding path.
- **Closure/auto-close timing stays readable.** §4B boundary: timing/event-state remain
  operationally clear so `closure-timeout.ts` and `closure-consent.ts` keep working. This
  is the ZK boundary, disclosed, not a leak.

---

## 8. Review status — resolved vs. still open

The crypto + legal review has answered (input to gates 2 & 3, not a substitute for formal
sign-off).

**Resolved by the review** (now in the design):
1. **Primitives ratified** — P-256 ECDH + HKDF-SHA256 + AES-256-GCM (ECIES); libsodium/WASM
   rejected; per-wrap algorithm identifier for a later X25519/PQ migration. **No custom
   crypto.**
2. **Org-key delivery** — per-seat wrapping of the org private key (N wrapped copies, never
   plaintext); seat-key custody via the WebAuthn PRF extension.
3. **Rotation is tamper-evident** — a remaining seat re-wraps client-side and the rotation is
   signed into the chain (not forgeable, not silently omissible).
4. **Correctness fixes required** — counter-based IV; AAD binds `captureId ‖ chunkIndex ‖
   finalFlag`; the chain records the expected chunk count (anti-truncation); a **signed
   pre-encryption plaintext commitment** (admissibility).
5. **Disclosure honesty** — the copy must state the **org can read content** (BLACK BOX
   cannot), not only that the operator cannot.

**Still open** (for the reviewers to close, before/during Phase 1): epoch-key hierarchy vs
full re-wrap on rotation (scale vs a departed seat retaining tenure-era access); PRF
salt-handling + no-PRF fallback; post-quantum hybrid on the roadmap; legal confirmation that
a signed plaintext commitment satisfies authentication and that per-instance re-encryption
preserves custody; DPA scoped to **metadata** (ZK narrows scope, does not eliminate it).

---

*Companion document: [ENVELOPE_DESIGN.md](./ENVELOPE_DESIGN.md) — the ratified primitive
stack, per-chunk framing, the nine-state operations, and the phased, flag-gated build plan.*
