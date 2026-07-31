# BLACK BOX — FIX BRIEF (assign next free git number) — ZERO-KNOWLEDGE CAPTURE ENCRYPTION + KEY CUSTODY (the encryption block)

**THE RISKIEST BUILD IN THE PROJECT. ISOLATED — never stacked on tenancy or anything else.**
**Authored now; execute LAST** — after Accounts AND Tenancy have shipped and the trigger/closure floor is
`known-good`. **Two phases, built as SEPARATE commits/briefs** (Phase 2 only after Phase 1 is proven).
**Flag-gated rollout. Independent crypto review + legal chain-of-custody review are non-negotiable pre-production
gates.** A crypto bug here means one of three severe outcomes: survivor's evidence lost forever, the
"zero-knowledge" claim is false, or a coordinator can't decrypt to run a live response. Treat accordingly.

---

## CUSTODY MODEL (locked)
- **Survivor** — owns their capture, holds a key, always.
- **Organization (NOT the individual coordinator)** — holds a key to OPERATE (live decrypt to run the response).
  Encrypt to the **ORG key**, because first-responder-wins elects the coordinator *after* the event starts and
  the survivor may be incapacitated — you cannot grant access in the moment. Any authorized seat operates via
  the org key.
- **Server / Royce** — NEVER. Stores ciphertext + integrity hash only. "I have storage access" = "I have blobs
  I can't open," true by construction.
- **Authorities / courts** — only by deliberate, survivor-authorized re-encryption to their key, logged. Never a
  standing copy.
- **Operating ≠ releasing:** the org key OPERATES; the survivor's authority RELEASES. Two different powers.

## ARCHITECTURE — envelope encryption
- Per-capture random data key (DEK). Capture encrypted **on-device before it leaves.**
- DEK wrapped to the survivor's public key AND the org's public key. Wrapped DEKs stored with the ciphertext.
- Server stores: ciphertext (R2) + integrity hash + wrapped DEKs (D1). Never a DEK in clear, never a private key.
- Decrypt = client-side unwrap with the survivor or org private key. Private keys are provisioned by the client
  and NEVER reach the server in readable form.
- **Primitives:** established, audited libraries only (WebCrypto / libsodium). Standard constructions
  (e.g., X25519 ECDH key-wrap + XChaCha20-Poly1305 / AES-GCM AEAD for the DEK). **NO custom crypto.** Final
  primitive selection is validated by the crypto review gate, not assumed from this brief.

---

## PHASE 1 (build FIRST, its own commit) — at-rest envelope encryption + key custody
- **Keypairs:** survivor keypair generated on-device at account creation (needs Accounts); org keypair at org
  creation (needs Tenancy, populates the reserved `org_pubkey`). Public keys server-side; private keys
  client-custodied.
- **Capture pipeline:** encrypt on-device → wrap DEK to survivor + org → upload ciphertext + hash + wrapped DEKs.
  Server stores ciphertext only.
- **Non-live decrypt (review):** survivor or an authorized org seat unwraps the DEK client-side and decrypts.
- **Org-key rotation on seat offboarding:** a departed seat must lose access — re-wrap DEKs to the rotated org
  key. Required, not optional.
- **Metadata:** location must be operable by the coordinator, so wrap it to the org key (NOT server-plaintext).
  Decide the rest of the metadata (timing, contact graph) — wrapped vs operationally clear (DECISION below).
- **PRODUCTION SAFETY:** capture is the most safety-critical path in the system. Behind a flag; proven on test
  accounts; live capture NEVER breaks during rollout — a survivor mid-event still gets their capture recorded
  even mid-migration. Zero-regression on capture is paramount and comes before any encryption goal.

**Phase 1 acceptance:**
- `[A]` server holds only ciphertext + hash + wrapped DEKs; no DEK-in-clear, no private key, anywhere server-side.
- `[L]` a captured blob is decryptable by the survivor client-side and by an authorized org seat, and by NO ONE
  else (server cannot decrypt — prove it).
- `[L]` offboarding a seat + org-key rotation revokes that seat's decrypt access to prior captures.
- `[L]` live capture path unbroken behind the flag — a mid-event survivor's capture still records.

## PHASE 2 (build SECOND, its own commit, only after Phase 1 proven) — live-stream coordinator decryption
- During a live event, the elected coordinator's client unwraps the DEK via the org key and decrypts stream
  chunks in real time to run the response.
- First-responder-wins: the elected coordinator's client holds the org key → decrypts; others demote.
- **Perf:** live decryption must not lag the response; bound the per-chunk AEAD overhead.
- Transient plaintext exists on the coordinator's device during live operation — inherent, and audit-logged.

**Phase 2 acceptance:**
- `[L]` elected coordinator decrypts the live stream in real time via the org key; a demoted seat cannot.
- `[L]` decryption keeps pace with the live response (bounded latency).
- `[A]` every live decrypt is audit-logged.

---

## RELEASE TO AUTHORITIES (survivor-authority; spans both phases)
- Survivor authorizes → re-encrypt the specific evidence to the authority's key → a **logged key-provisioning
  event**, not a download-and-forward. Re-encryption requires a transient decrypt on the survivor's (or a
  survivor-authorized coordinator's) device — a controlled, logged plaintext moment.
- **Audit every decrypt and every release** (who opened what, when). **Watermark** each capture with
  account/org/seat id so any leak traces to a seat.
- Two layers: crypto controls who CAN decrypt; audit + watermark + the DPA control what they may DO after.

## PRE-PRODUCTION GATES (non-negotiable)
1. Threat model written first.
2. Independent crypto review of the primitives + envelope design before any production code.
3. Legal review: chain-of-custody for court admissibility (is re-encrypted evidence admissible?),
   wiretapping/consent law on encrypted capture, DPA alignment. **Perfect crypto ≠ admissible evidence** — the
   custody *process* must be legally sound or the encryption is moot for the courts lane.
4. Flag-gated rollout with proven capture-path zero-regression.

## DECISIONS REQUIRED (Royce)
1. **Survivor key-loss:** recoverable (org-mediated re-provision — trades some ZK purity) vs pure ZK (lost
   forever). A survivor who loses phone + key in the same incident is foreseeable — decide deliberately.
2. **Metadata scope:** what's wrapped-to-org beyond location vs operationally clear.
3. **Retroactive encryption:** encrypt existing captures or new-only.
4. **Re-encryption to authorities:** survivor-only, or survivor-authorized coordinator may perform it.

**Dependency chain:** Accounts → Tenancy → Phase 1 → Phase 2. Execute LAST, in that order, nothing stacked.
