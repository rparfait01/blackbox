# Brief 26 — Zero-Knowledge Custody: ENVELOPE DESIGN

**Status:** Revised per the crypto + legal review answers (rev 2). Companion to
[THREAT_MODEL.md](./THREAT_MODEL.md). The primitives are now **ratified**; three items
remain explicitly open for the reviewers to decide (§11). **The review answers are input
to gates 2 & 3, not a substitute for formal sign-off — no production crypto ships until
that sign-off, and the build begins only on the operator's go.**

Everything is grounded in the current code (insert points cited by file). The design's
first commitment is the [THREAT_MODEL §0 non-goal](./THREAT_MODEL.md#0-the-paramount-non-goal-read-this-first):
**capture availability outranks confidentiality.**

---

## Review outcome — the five build changes this design now carries

The crypto + legal review required five concrete changes, all folded into the sections
below. They are load-bearing — the first two are correctness/legal defects that a naive
envelope would ship with:

1. **Signed pre-encryption plaintext commitment per chunk** (§4a) — *admissibility.* The
   chain must commit to the **plaintext**, hashed on-device before encryption, not only to
   the ciphertext. Otherwise the integrity proof authenticates the wrong artifact under
   FRE 901 and re-encryption is a genuine chain-of-custody weak point.
2. **AEAD binds position; the chain records the chunk count** (§3a) — *anti-truncation.*
   GCM authenticates content, not order. AAD must bind `captureId ‖ chunkIndex ‖ finalFlag`
   and the chain must record an expected count / terminal marker, or a silently truncated
   recording still verifies. *A truncated assault recording that verifies is the worst
   failure here.*
3. **Counter-based IV, not random** (§3a) — a 96-bit IV = 32-bit random per-capture prefix
   ‖ 64-bit chunk counter. Single-writer, so a counter is available and removes the
   birthday-bound collision risk of random IVs.
4. **Algorithm identifier stored per wrapped key** (§3) — makes X25519 (and a future
   post-quantum hybrid) a config change, not a migration/rewrite.
5. **Disclosure states the org can read content** (§9) — the survivor must not conclude
   *nobody* can read it. Their organization can.

Still **open** for the reviewers (§11): epoch-key hierarchy vs full re-wrap on rotation;
WebAuthn PRF for seat-key custody; a post-quantum hybrid wrap on the roadmap.

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

## 3. Primitive stack — RATIFIED

**No custom crypto. WebCrypto only — libsodium/WASM rejected** (bundle weight + supply-chain
surface on a PWA, for no security gain). Standard ECIES; do not improvise around it.

| Layer | Ratified choice |
|---|---|
| **Key wrap** | ECDH **P-256** with an **ephemeral sender keypair per wrap** → **HKDF-SHA256** → **AES-256-GCM** key-wrap. Standard ECIES. |
| **Content** | **AES-256-GCM**, per-capture random **256-bit** data key |
| **Stored per wrap** | `algId ‖ ephemeralPubKey ‖ IV ‖ ciphertext ‖ tag` |
| **Signing (exists)** | Ed25519 integrity chain — unchanged, content-agnostic |

**Why P-256 over X25519, for now:** X25519 is native in all three engines and now in the
official W3C WebCrypto spec, **but only recently** (Chrome landed the Curve25519 family in
137 / May 2025, ~79% of users then). P-256 has been universal for a decade and is
FIPS-aligned (helps government/institutional buyers). **For a safety tool, universal beats
elegant.** The wrap layer stores an **algorithm identifier per wrapped key** (change #4), so
X25519 — and a future post-quantum hybrid — is a config change, not a migration.

**Long-horizon flag (roadmap, not pilot):** captures may need confidentiality for years, so
harvest-now-decrypt-later is a real evidence risk. A hybrid **ECDH + ML-KEM** key wrap
belongs on the roadmap; the per-wrap `algId` reserves the seam for it.

### 3a. Per-chunk framing, IV, and position binding (correctness-critical)

Each ~1s chunk is independently decryptable (required for the live MSE path and to avoid the
`/audio/full` concat problem, §6). The framing carries the review's anti-truncation and
IV requirements:

- **IV (change #3): counter-based, never random.** 96-bit IV = **32-bit random per-capture
  prefix ‖ 64-bit chunk counter.** Single-writer stream, so the counter is always available
  and `(key, IV)` collision is eliminated — random 96-bit IVs sit on the birthday bound for
  no reason.
- **AAD (change #2): bind position.** GCM authenticates *content, not order.* The AAD of each
  chunk **must bind `captureId ‖ chunkIndex ‖ finalFlag`**, so chunks cannot be reordered,
  dropped, or spliced between captures with every tag still verifying.
- **The chain records an expected chunk count / terminal marker.** Without it, silently
  dropping trailing chunks is undetectable. A truncated assault recording that still verifies
  is the worst possible failure — this is a hard requirement, not a nicety.
- Stored chunk = `[version ‖ algId ‖ IV ‖ AEAD(key, plaintext=(mimeHeader ‖ chunkBytes),
  aad=(captureId ‖ chunkIndex ‖ finalFlag))]`. The true mime travels *inside* the envelope
  (`X-Mime-Type` goes generic on the wire); the client recovers it after decrypt.

### 3b. Plaintext commitment (change #1 — admissibility; see §4a)

Alongside the ciphertext hash, the client computes a hash of each chunk's **plaintext,
on-device before encryption**, and signs it into the chain. This is what a court's expert
verifies a later decryption against — the commitment was made at capture time by a party who
did not retain the plaintext. Without it, the chain proves only that ciphertext was
unaltered, which is the wrong artifact for FRE 901 authentication.

---

## 4. The nine states → concrete operations

| State | Operation | Where (from recon) |
|---|---|---|
| 1 Created | MediaRecorder produces a chunk Blob | `media-capture.ts` (unchanged) |
| 2 Sealed | Client hashes the **plaintext** (§4a), then generates a 256-bit DEK and AEAD-encrypts the chunk with position-binding AAD (§3a) | **insert in `upload-manager.ts sendItem`**, between `blob.arrayBuffer()` and `signRequest` — hash plaintext → encrypt → sign the ciphertext (sign already covers body bytes) |
| 3 Wrapped | Client wraps DEK → survivor pub + org pub (ECIES, §3) | same client step; fetch org pub from `GET /v1/me` (org context) at event open, cache |
| 4 Stored | Upload ciphertext + **ciphertext hash + signed plaintext commitment** + wrapped DEKs + chunk count | chunk POST **unchanged** for bytes; commitments + wrapped DEKs go in new D1 tables (§7). `appendToChain` hashes ciphertext — unchanged; the plaintext-commitment hash is signed into the same chain |
| 5 Operated (live) | Elected seat's client unwraps DEK via org key, decrypts each chunk | **insert in the dashboard MSE loop** (`dashboard/page.ts`, between `arrayBuffer()` and the MSE queue push) — sub-ms per chunk. Needs key delivery (§5) |
| 6 Reviewed | Survivor / authorized seat unwraps client-side to review | survivor client (survivor key) or seat client (org key); same decrypt primitive |
| 7 Released | Survivor authorizes → re-encrypt to recipient pub → logged | **reuse `exportPackage` + `custody_transfers` + Ed25519 manifest**; add: transient decrypt on the authorizing client, re-wrap DEK to the recipient's pub, log a `release` key-provisioning event |
| 8 Revoked | Seat offboarded → org-key rotation → re-wrap prior DEKs to new org key, **signed into the chain** | **wire to Brief 24 `leaveOrg`/admin-removal**; a *remaining* authorized seat's client re-wraps (only it can unwrap the old DEKs — the server cannot); the departed seat's cached key opens nothing. Rotation is signed by the performing seat and appended to the chain so it is neither forgeable nor silently omissible. **Scaling caveat + epoch-key alternative: open item, §11.** |
| 9 Deleted | Survivor deletes → ciphertext destroyed; hash + audit retained | R2 delete of chunk objects; keep `chunks_index.sha256` + audit metadata |

### 4a. Plaintext commitment — the admissibility fix (change #1)

The integrity chain today commits to the **ciphertext**, which proves the stored blob was
not altered. It does **not** prove that decrypted plaintext equals what the device captured —
and under FRE 901 authentication, opposing counsel attacks the *plaintext*, not the blob. So
the chain commits to plaintext at capture time:

- The client computes `H(plaintextChunk)` **on-device, before encryption**, and signs it into
  the chain alongside `H(ciphertext)`.
- Any later decryption — by survivor, coordinator, or a court's expert — is verified against a
  commitment made at capture time by a party who did not retain the plaintext afterward.
- With this, re-encryption (state 7) changes only the *container*; the plaintext commitment is
  the fixed point custody hangs on. Without it, re-encryption is a real chain-of-custody weak
  point. **The legal reviewer confirms whether a signed pre-encryption plaintext commitment
  satisfies authentication in the target jurisdictions.**

**Invariants enforced in code (guard-tested):** no DEK-in-clear or private key ever in a
server INSERT/env; every decrypt (5/6/7) calls `audit(env, eventId, 'decrypt', actorHash,
{seq, keyId, recipient?})`; release (7) writes a `custody_transfers` row, never a bare
download; a rotation (8) is a signed chain entry; captures carry a watermark
(account/org/seat id) inside the envelope.

---

## 5. Org-key delivery to an elected seat — RATIFIED (per-seat wrapping, never a shared secret)

The coordinator dashboard today authenticates with only the magic-link token
(`requireMagicToken`) and holds **no decryption key** (recon). The ratified mechanism:

- **Every seat has its own keypair.** On seat creation, the **org private key is wrapped to
  that seat's public key.** The server stores **N wrapped copies** of the org private key —
  one per active seat — and **never the plaintext org key.**
- At coordinator **claim** (Brief 23's deliberate `claim-coordinator` POST — an explicit,
  audited action, never a passive GET), the seat's client unwraps the org key locally, then
  unwraps the capture DEK. The server sees neither.
- **Revocation = rotate the org keypair + re-wrap to the remaining seats** (state 8). A
  demoted/departed seat is simply not among the re-wrap recipients.

**The hard part is the seat's *own* key, not the org key** — it must survive device loss and
work across the seat's devices. **Ratified approach: the WebAuthn PRF extension** — derive a
stable secret from the seat's existing passkey (already shipped, passwordless) and use it to
encrypt the seat's private key at rest. No new credential, no password. **The crypto reviewer
vets PRF salt handling and the fallback path for authenticators lacking PRF.**

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
  recipientRef, keyGeneration, algId, wrappedDek BLOB, createdAt)` — the set of wrapped DEKs
  per chunk. **`algId` per row** (change #4) so the wrap algorithm is data, not code. No
  plaintext DEK column exists, by construction.
- New table `org_key_grants (orgId, seatUserId, keyGeneration, algId, wrappedOrgPrivKey BLOB,
  createdAt)` — the **N per-seat wrapped copies** of the org private key (§5). One row per
  active seat per generation; no plaintext org key column exists.
- New table `plaintext_commitments (eventId, sequence, plaintextHash, signature, createdAt)`
  — the **signed pre-encryption plaintext commitment** per chunk (§4a, change #1).
- `chunks_index` gains `chunkCount`/`isFinal` (or a terminal marker) so a **truncated tail is
  detectable** (change #2); the `sha256` column already stores the ciphertext hash unchanged.

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

The product disclosure must state, plainly — and the legal reviewer's change #5 is included:
a survivor reading "BLACK BOX cannot read your captures" may reasonably conclude *nobody*
can. **Their organization can.** That must be said.

> **Your organization can open your recording to coordinate a response. BLACK BOX cannot.
> You decide if it ever goes anywhere else.**
>
> BLACK BOX cannot read the content of your captures (audio/video) or, once enabled, your
> location — those are encrypted to keys we do not hold. BLACK BOX **can** see *that* an
> alert happened and *when* (timing and event state), because that is what lets an alert be
> closed and lets the safety backstop stop an event from hanging open. We track counts, not
> content.

Do not claim timing/state is hidden — it is readable by design (§4B). Do not let the
survivor infer the org cannot read content — it can. Overclaiming is a trust failure worse
than the honest boundary.

---

## 10. Phased build plan (post-gate)

1. **Phase 0 (this session): threat model + this design → the two review gates.** No prod
   crypto.
2. **Phase 1 — at-rest chunk envelope**, flag OFF → test accounts. Keypair generation
   (survivor + org, per-seat org-key grants §5), client hash-plaintext-then-encrypt at
   `sendItem` with counter IV + position-binding AAD (§3a), signed plaintext commitment
   (§4a), wrapped-key + commitment storage, chunk-count/terminal marker, non-live decrypt
   (states 1–4, 6), fail-open. Prove server-cannot-decrypt **and** that a truncated tail is
   detectable.
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

## 11. Open decisions still on the table

The primitives are ratified (§3). These three remain explicitly open for the reviewers to
decide before or during Phase 1:

1. **Rotation: epoch-key hierarchy vs full re-wrap (§4 state 8).** Full re-wrap (N captures ×
   re-wrap, client-side on one admin's browser) is fine at pilot scale but does not scale to
   thousands of seats. An epoch-key hierarchy (org key wraps an epoch key; captures wrap to
   the epoch; rotation re-wraps only epoch keys) scales — but a departed seat that cached the
   old epoch key **retains access to captures from their tenure**. *Crypto reviewer picks the
   trade.* Note: retroactive revocation is partly theatre either way — a seat with legitimate
   access could already have saved plaintext; **watermark + audit is the real control on what
   a seat did**, and the DPA must say so honestly rather than imply crypto solves it.
2. **WebAuthn PRF for seat-key custody (§5).** Ratified as the approach; the reviewer vets PRF
   salt handling and the fallback for authenticators lacking PRF.
3. **Post-quantum hybrid on the roadmap (§3).** Whether ECDH + ML-KEM hybrid wrap belongs on
   the roadmap for long-horizon evidence confidentiality. The per-wrap `algId` reserves the
   seam; the decision is timing, not architecture.

**Legal reviewer, confirmed open:** whether a signed pre-encryption plaintext commitment
(§4a) satisfies FRE-901-style authentication in the target jurisdictions and whether
per-instance re-encryption preserves custody; DPA scoped to **metadata** (ZK narrows scope,
does not eliminate it — BLACK BOX remains a processor of timing/state/contact-graph, not of
content it cannot read).

**Operator (Royce):** confirm Phase-1-chunks-first vs §4B-location-now phasing; confirm
individual-survivor key-loss ("device + code lost = gone") is acceptable and disclosed;
approve the revised disclosure copy (§9).

---

*Nothing in this document is a commitment to ship. It is the revised input to the §5 gates.
On formal sign-off and the operator's go, Phase 1 begins as a flag-OFF,
capture-path-zero-regression build carrying the five changes above.*
