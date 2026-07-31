# BRIEF 26 — REVIEW ANSWERS (input to gates 2 & 3, not a substitute for them)

---

# CRYPTO

## Q1 — Ratify the primitive stack

**Answer: P-256 + HKDF-SHA256 + AES-256-GCM. Ship this. X25519 later, not now.**

| | |
|---|---|
| **Key wrap** | ECDH P-256 (ephemeral sender keypair per wrap) → HKDF-SHA256 → AES-256-GCM key-wrap. This is standard ECIES; do not improvise around it |
| **Content** | AES-256-GCM, per-capture random 256-bit data key |
| **Store per wrap** | ephemeral public key ‖ IV ‖ ciphertext ‖ tag |
| **Reject** | libsodium/WASM dependency — bundle weight and supply-chain surface on a PWA, for no security gain here |

**On X25519:** now native in all three engines and promoted to the official W3C WebCrypto spec — but only recently. Chrome landed the Curve25519 family in **137 (May 2025)**, at <cite index="13-1">roughly 79% of web users at the time</cite>. P-256 has been universal for a decade. **For a safety tool, universal beats elegant.** P-256 is also FIPS-aligned, which helps with government and institutional buyers.
→ Build the wrap layer **algorithm-agnostic** (store an alg identifier per wrapped key) so X25519 is a config change, not a migration.

**Flag for the reviewer:** captures may need to stay confidential for years. Harvest-now-decrypt-later is a real long-horizon risk for evidence. Not a pilot concern — but ask whether a hybrid (ECDH + ML-KEM) key wrap belongs on the roadmap.

## Q2 — Org-key delivery to an elected seat

**Answer: per-seat wrapping of the org private key. Never a shared secret.**

- Every seat has their **own keypair**. On seat creation, the **org private key is wrapped to that seat's public key.**
- Server stores **N wrapped copies** of the org private key — one per active seat. Never the plaintext.
- At coordinator claim, the seat's client unwraps the org key locally, then unwraps the capture DEK. Server never sees either.
- Revocation = rotate + re-wrap to remaining seats (Q3).

**The hard part is the seat's own key, not the org key.** It must survive device loss and work across the seat's devices.

→ **Recommended: WebAuthn PRF extension.** Derive a stable secret from the seat's existing passkey and use it to encrypt their private key at rest. No new credential, no password, consistent with the passwordless model already shipped. Ask the reviewer to vet PRF salt handling and the fallback path for authenticators lacking PRF.

## Q3 — Rotation and re-wrap (state 8)

**Who re-wraps: a remaining authorized seat, client-side. Not the server — it cannot.**

Sequence: remaining admin unwraps old org key → generates new org keypair → for each affected capture, unwraps DEK with old key and re-wraps to new → uploads new wrapped DEKs → wraps new org private key to each remaining seat.

**Tamper-evidence:** the rotation event is signed by the performing seat and appended to the existing hash chain. A rotation must not be forgeable or silently omissible.

**Two things to state plainly rather than paper over:**

- **Mass re-wrap does not scale.** N captures × re-wrap, client-side, on one admin's browser. Fine at pilot scale; painful at 5,000 seats. The alternative is an **epoch-key hierarchy** — org key wraps an epoch key, captures wrap to the epoch — so rotation re-wraps only epoch keys. Trade-off: a departed seat that cached the old epoch key retains access to captures from their tenure. **Ask the reviewer to pick.**
- **Retroactive revocation is partly theater.** A seat with legitimate access could already have saved plaintext. Re-wrap stops *future server-mediated* access; it cannot un-see what was seen. **Watermarking + audit is the real control on what a seat did.** Say this honestly in the DPA rather than implying crypto solves it.

## Q4 — Chunk framing, IV, encrypt-then-sign

**IV — do not use random IVs.**
- 96-bit IV = **32-bit random per-capture prefix ‖ 64-bit chunk counter.**
- Single-writer stream, so a counter is available and eliminates (key, IV) collision entirely. Random 96-bit IVs put you on the birthday bound for no reason.

**AAD — this is the gap most designs miss.**
- GCM authenticates content, **not position.** Without binding, chunks can be reordered, dropped, or spliced between captures and every tag still verifies.
- **AAD must bind: capture id ‖ chunk index ‖ final-chunk flag.**
- The chain must record an **expected chunk count or terminal marker** — otherwise silently dropping trailing chunks is undetectable. A truncated assault recording that still verifies is the worst possible failure here.

**Ordering — as described is correct.** Encrypt → hash ciphertext → append to signed chain. The existing request HMAC covers transport; the chain covers storage. Two layers, distinct purposes, no conflict.

---

# LEGAL

## Q5 — Admissibility of re-encrypted evidence

**⚠️ REAL GAP — fix this in the design before the legal review, not after.**

The dossier says the hash chain covers the **ciphertext**. That proves the ciphertext was not altered. **It does not prove that decrypted plaintext equals what the device captured.** For authentication under FRE 901, that is the wrong artifact — opposing counsel attacks the plaintext, not the blob.

**Fix: commit to the plaintext at capture time.**
- Compute a hash of each plaintext chunk **on-device, before encryption**, and sign it into the chain alongside the ciphertext hash.
- Any later decryption — by survivor, coordinator, or a court's expert — can then be verified against a commitment made at capture time, by a party who did not hold the plaintext afterward.
- Without this, re-encryption is a genuine chain-of-custody weak point. With it, re-encryption changes only the container.

**For the lawyer:** does a signed pre-encryption plaintext commitment satisfy authentication in the target jurisdictions, and does per-instance re-encryption to a recipient's key preserve custody or break it?

## Q6 — Wiretap / consent

**Encryption does not change the consent analysis.** Recording is recording; who can read it afterward is a separate question from whether making it was lawful. This is already covered in Terms v2 §3–4 (activation is instant and unconditional, no jurisdiction check, self-protection premise). **Keep the two analyses separate** — do not let anyone argue encryption mitigates a consent problem.

## Q7 — DPA alignment

**Worth the lawyer's specific attention:** under zero-knowledge, BLACK BOX arguably cannot be a *processor of content it cannot read* — but it remains a processor of **metadata** (timing, event state, contact graph if unwrapped). **ZK narrows DPA scope; it does not eliminate it.** Ask counsel to scope the DPA to metadata explicitly rather than treating content and metadata identically.

Audit + per-seat watermarking is the "what a seat may do" layer. Crypto controls who *can* decrypt; the DPA controls what they may do after. Two layers, and the DPA should say so.

## Q8 — Disclosure copy

**The copy is accurate about BLACK BOX. It omits something material: the ORG can read the content.**

A survivor reading *"BLACK BOX cannot read the content of your captures"* may reasonably conclude **nobody** can. Their shelter can. That must be stated.

**Suggested addition:**

> "Your organization can open your recording to coordinate a response. BLACK BOX cannot. You decide if it ever goes anywhere else."

Everything else in the copy holds — the timing/state boundary is disclosed honestly and claims no more than is true.

---

# BUILD CHANGES THIS REVIEW REQUIRES

1. **Add a signed pre-encryption plaintext commitment per chunk** (Q5) — admissibility.
2. **AAD binds capture id ‖ chunk index ‖ final flag; chain records expected chunk count** (Q4) — truncation/reorder.
3. **Counter-based IV, not random** (Q4).
4. **Algorithm identifier stored per wrapped key** (Q1) — X25519 migration path without a rewrite.
5. **Disclosure copy states the org can read content** (Q8).

**Open for the reviewers to decide:** epoch-key hierarchy vs full re-wrap (Q3) · WebAuthn PRF for seat-key custody (Q2) · post-quantum hybrid on the roadmap (Q1).
