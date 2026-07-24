# Brief 26 — Zero-Knowledge Custody: ENVELOPE DESIGN

**Status:** Draft for the §5 pre-production gates (deliverable #2). Companion to
[THREAT_MODEL.md](./THREAT_MODEL.md). **This proposes primitives and structure for an
independent crypto reviewer to ratify or override — nothing here is assumed correct, and
no production crypto ships before that review + the legal chain-of-custody review.**

Everything is grounded in the current code (insert points cited by file). The design's
first commitment is the [THREAT_MODEL §0 non-goal](./THREAT_MODEL.md#0-the-paramount-non-goal-read-this-first):
**capture availability outranks confidentiality.**

---

## 1. Scope of Phase 1 (what is actually encrypted first)

From recon, the **audio/video chunk media in R2 is the clean zero-knowledge target**: the
server already treats chunk bytes as opaque — it only `sha256`-hashes them, `MEDIA.put`s
them, and streams them back (`index.ts` chunk route; `MEDIA.put(r2Key, bytes, …)`). It
never decodes chunk content. Encrypting chunks therefore requires **zero server logic
change** and no integrity-chain change (the chain hashes ciphertext identically —
`integrity.ts hashBytes`).

**Phase 1 encrypts: chunk media (R2).** Everything else is deferred or out of the envelope:

| Artifact | Store | Phase 1 treatment | Rationale |
|---|---|---|---|
| Audio/video chunks | R2 `MEDIA` | **Encrypted** (this phase) | Server already blind; clean insert; highest-value content |
| Location | D1 `locations_index` | **Deferred** to a later phase (§4B: wrap-to-org) | Server *reads/processes* it for the live dashboard + SSE; wrapping blinds `getContactState`/`locationStream`/CAD. Real latency + rework cost — do it deliberately, not bundled |
| Transcripts / classifications | D1 | Deferred / out | Same as location — server-processed for the dashboard |
| Timing / event state | D1 `events` | **Operationally clear — never encrypted** (§4B ZK boundary) | Closure consent + auto-close backstop depend on it |

This phasing is itself a **decision for the gate to confirm**: §4B says location is
wrapped-to-org; the recon shows that is a much larger change than chunk media because the
server actively reads location. The proposal is to ship chunk-media ZK first (Phase 1),
prove it, then take location (Phase 1b) as its own flagged step — never bundling the risky
server-blinding change with the clean one.

---

## 2. Key hierarchy

```
Survivor keypair (per account)      Org keypair (per org)
  - generated on-device at            - generated at org creation (Brief 24 admin #1
    account creation                    registration is the natural point)
  - PRIVATE key: client-custodied,    - PRIVATE key: held by authorized seats'
    never server-readable               clients while operating; NEVER server-readable
  - PUBLIC key: stored server-side    - PUBLIC key: populates the RESERVED
    (new users.pubkey column)           organizations.orgPubkey (Brief 23, currently null)
        \                                      /
         \                                    /
          v                                  v
     Per-capture Data Encryption Key (DEK) — random, one per capture
       - encrypts the chunk bytes (AEAD)
       - stored ONLY wrapped: wrap(DEK → survivor pub) AND wrap(DEK → org pub)
       - never stored in clear, never leaves a client in clear
```

Envelope encryption, textbook shape: random DEK per capture; content under the DEK; DEK
wrapped to each authorized public key. To add a reader you add a wrapped-DEK; to revoke a
reader you rotate that reader's keypair and re-wrap (state 8). The server stores ciphertext
+ hash + the set of wrapped DEKs, and can open none of it.

---

## 3. Primitive proposal (FOR THE CRYPTO REVIEW TO RATIFY — not assumed)

**No custom crypto.** Established, audited primitives only. Two candidate stacks; the
reviewer picks:

| Layer | Proposal A — WebCrypto (native) | Proposal B — libsodium (wasm) |
|---|---|---|
| Keypair | ECDH **P-256** (`generateKey({name:'ECDH', namedCurve:'P-256'})`) | X25519 |
| DEK (content AEAD) | **AES-256-GCM**, random 96-bit IV per chunk | XChaCha20-Poly1305, random 192-bit nonce |
| DEK wrapping | ECDH-derive a KEK to survivor/org pub → AES-KW / AES-GCM wrap the DEK | `crypto_box_seal` (anonymous sealed box) to the pub key |
| Signing (exists) | Ed25519 integrity chain — unchanged | unchanged |

**Recommendation: Proposal A (WebCrypto)** — native, no wasm payload, no supply-chain
surface, available in the PWA and the worker-rendered coordinator dashboard JS. P-256 is
ubiquitous and hardware-accelerated. Proposal B (sealed boxes) is ergonomically simpler for
"wrap to a pubkey" and worth the reviewer's consideration if the wasm cost is acceptable.
**The reviewer decides; this document does not bind it.**

Per-chunk framing (so each ~1s chunk is independently decryptable — required for the live
MSE path and to avoid the `/audio/full` concat problem, §6): each stored chunk =
`[version | IV | AEAD-ciphertext-of-(mime-header ‖ chunk-bytes)]`. The true mime travels
*inside* the envelope (recon caveat: `X-Mime-Type` must go generic on the wire); the client
recovers it after decrypt.

---

## 4. The nine states → concrete operations

| State | Operation | Where (from recon) |
|---|---|---|
| 1 Created | MediaRecorder produces a chunk Blob | `media-capture.ts` (unchanged) |
| 2 Sealed | Client generates DEK, AEAD-encrypts the chunk bytes | **insert in `upload-manager.ts sendItem`**, between `blob.arrayBuffer()` and `signRequest` — encrypt, then sign the ciphertext (sign already covers body bytes) |
| 3 Wrapped | Client wraps DEK → survivor pub + org pub | same client step; fetch org pub from `GET /v1/me` (org context) at event open, cache |
| 4 Stored | Upload ciphertext + hash + wrapped DEKs | chunk POST **unchanged** for bytes; wrapped DEKs go in a new D1 table (below). `appendToChain` hashes ciphertext — unchanged |
| 5 Operated (live) | Elected seat's client unwraps DEK via org key, decrypts each chunk | **insert in the dashboard MSE loop** (`dashboard/page.ts`, between `arrayBuffer()` and the MSE queue push) — sub-ms per chunk. Needs key delivery (§5) |
| 6 Reviewed | Survivor / authorized seat unwraps client-side to review | survivor client (survivor key) or seat client (org key); same decrypt primitive |
| 7 Released | Survivor authorizes → re-encrypt to recipient pub → logged | **reuse `exportPackage` + `custody_transfers` + Ed25519 manifest**; add: transient decrypt on the authorizing client, re-wrap DEK to the recipient's pub, log a `release` key-provisioning event |
| 8 Revoked | Seat offboarded → org-key rotation → re-wrap prior DEKs to new org key | **wire to Brief 24 `leaveOrg`/admin-removal**; an active seat's client re-wraps (it can unwrap the old DEKs); departed seat's cached key is now useless |
| 9 Deleted | Survivor deletes → ciphertext destroyed; hash + audit retained | R2 delete of chunk objects; keep `chunks_index.sha256` + audit metadata |

**Invariants enforced in code (guard-tested):** no DEK-in-clear or private key ever in a
server INSERT/env; every decrypt (5/6/7) calls `audit(env, eventId, 'decrypt', actorHash,
{seq, keyId, recipient?})`; release (7) writes a `custody_transfers` row, never a bare
download; captures carry a watermark (account/org/seat id) inside the envelope.

---

## 5. Coordinator live decrypt — key delivery (the real Phase-2 problem)

The coordinator dashboard today authenticates with only the magic-link token
(`requireMagicToken`) and holds **no decryption key** (recon). Making the elected seat able
to decrypt needs the **org private key (or a per-event DEK-set wrapped to the seat)**
delivered to that seat's client — new surface, not just an insert.

**Proposal:** the org private key is provisioned to a seat's client at the coordinator
**claim** step (Brief 23's deliberate `claim-coordinator` POST — already an explicit,
audited action, never a passive GET), delivered wrapped to the *seat account's* own key
(the coordinator is a registered admin/coordinator account from Brief 24, so they have a
keypair). The elected seat unwraps the org key locally; a demoted seat never receives it.
The crypto reviewer must vet this delivery (it is the crux of "operability without giving
the server a readable key").

**Latency:** per-chunk AES-GCM decrypt of ~1s media is sub-millisecond, negligible against
the 1s SSE / 3s poll cadence — **not** a performance risk. The response is not slowed.

---

## 6. The `/audio/full` obstacle (must be solved before Phase 2)

`/v1/c/:id/audio/full` (`index.ts`) streams a **server-side Range-sliced concatenation** of
all R2 chunk objects. Server-side concat is **incompatible** with per-chunk envelope crypto
(the server can't join ciphertext into one decryptable stream). This path backs the
iOS-Safari no-MSE fallback player and the video element. **Resolution:** when the flag is
ON, the coordinator client fetches chunks individually, decrypts each, and concatenates
*client-side*; `/audio/full` is bypassed for encrypted events. This is a dashboard-JS
change, not a crypto change, but it is a Phase-2 blocker and is called out so the reviewer
sees it.

---

## 7. Schema additions (dormant until the flag arms; additive/nullable)

Proposed for a future migration — **written but unused while the flag is OFF**, so the
capture path is byte-identical:

- `users.pubkey TEXT` — survivor public key (SPKI/base64). Nullable.
- `organizations.orgPubkey` — **already exists**, reserved null in Brief 23; this brief
  starts populating it at org creation.
- `organizations.orgPubkeyGeneration INTEGER` — rotation counter for state 8.
- New table `wrapped_keys (id, eventId, sequence, recipientType[survivor|org|recipient],
  recipientRef, wrappedDek BLOB, keyGeneration, createdAt)` — the set of wrapped DEKs per
  chunk. No plaintext DEK column exists, by construction.
- `chunks_index` unchanged (already stores `sha256` of whatever bytes are uploaded).

**Tally severance:** none of these reference `incident_tally`. No FK, no join, no
derivation — Brief 25's severance guard stays green.

---

## 8. Flag plan + zero-regression proof

Two flags, both default **OFF**, matching existing patterns (recon):

- Client (build-time): `VITE_ENVELOPE_ENC` → `export const encryptionEnabled = (...) === 'true'`
  (like `apps/pwa/src/lib/env.ts`). Gates the `sendItem` encrypt step. OFF ⇒ the upload
  pipeline is a strict no-op, byte-identical to today.
- Worker (deploy-time `--var`): `ENVELOPE_ENCRYPTION_ENABLED` on `Env` (like
  `CONSENT_GATE_ENFORCED`). Gates the (minimal) server acceptance of wrapped-key rows.

**Fail-open on the capture path (non-negotiable):** even with the flag ON, if client
encryption throws for any reason, the client **falls back to the current plaintext upload**
rather than dropping the chunk. Availability (Threat Model §0) beats confidentiality every
time. This fallback is itself guard-tested.

**Zero-regression proof strategy:** (1) flag-OFF diff shows the capture path unchanged;
(2) the existing acceptance capture rows stay green with the flag off; (3) a new
"prove-the-server-cannot-decrypt" acceptance row with the flag on (test accounts); (4)
a seat-rotation revocation row (state 8); (5) `[L]` on-device: a mid-event survivor's
capture still records with the flag on.

---

## 9. Metadata boundary + disclosure (say only what is true)

The product disclosure must state, plainly:

> BLACK BOX cannot read the content of your captures (audio/video) or, once enabled, your
> location — those are encrypted to keys we do not hold. BLACK BOX **can** see *that* an
> alert happened and *when* (timing and event state), because that is what lets an alert be
> closed and lets the safety backstop stop an event from hanging open. We track counts, not
> content.

Do not claim timing/state is hidden — it is readable by design (§4B). Overclaiming is a
trust failure worse than the honest boundary.

---

## 10. Phased build plan (post-gate)

1. **Phase 0 (this session): threat model + this design → the two review gates.** No prod
   crypto.
2. **Phase 1 — at-rest chunk envelope**, flag OFF → test accounts. Keypair generation,
   client encrypt at `sendItem`, wrapped-key storage, non-live decrypt (states 1–4, 6),
   fail-open. Prove server-cannot-decrypt.
3. **Phase 1b — state 8** (seat offboarding → org rotation → re-wrap) wired to Brief 24
   offboarding. Prove revocation.
4. **Phase 1c — state 7** (release re-encryption) reusing `exportPackage`. Legal gate owns
   admissibility.
5. **Phase 2 — live coordinator decrypt** (state 5): key delivery at claim, `/audio/full`
   replacement, latency bound.
6. **Phase 1d (separate) — location wrap-to-org** (§4B), its own flag, accepting the
   dashboard rework.

Each phase is its own flagged, currency-asserted deploy with capture-path zero-regression
re-proven. **Brief 27 (Guided Intake) does not begin until this is proven in production.**

---

## 11. Open decisions for the reviewers (consolidated)

**Crypto reviewer:** ratify Proposal A vs B; vet the org-key-delivery-at-claim mechanism
(§5); vet the org-rotation/re-wrap for state 8 (who re-wraps, tamper-evidence); confirm the
per-chunk framing + IV handling; confirm encrypt-then-sign ordering with the existing HMAC.

**Legal reviewer:** admissibility of re-encrypted evidence; chain-of-custody preservation
across re-encryption; wiretap/consent law on encrypted capture; DPA alignment with
watermark + audit as the "what they may do" layer.

**Operator (Royce):** confirm the Phase-1-chunks-first vs §4B-location-now phasing; confirm
individual-survivor key-loss ("device + code lost = gone") is acceptable and disclosed;
confirm the metadata disclosure copy (§9).

---

*Nothing in this document is a commitment to ship. It is the input to the §5 gates. On
sign-off, Phase 1 begins as a flag-OFF, capture-path-zero-regression build.*
