# BRIEF 29 — CERTIFIED REPORT

**Status: BUILT DORMANT.** Gated on `ENVELOPE_ENCRYPTION_ENABLED`. With the flag off — which
is the state today — no report path exists, `/verification` is not served, and the system is
byte-identical to before this brief.

---

## The gate, stated plainly

Brief 29 opens with: *"GATE: Brief 26 ZK custody proven in production (capture-time plaintext
commitments must exist)."*

**That gate is not met, and was not met when this was built.** Checked against production on
2026-07-25:

| Gate condition | Production |
|---|---|
| Capture-time plaintext commitments exist | `plaintext_commitments` = **0 rows**, across **4,002** captured chunks |
| Survivor keys provisioned | `users.pubkey` = **0 rows** |
| `ENVELOPE_ENCRYPTION_ENABLED` armed | no such `--var` on the worker; client `VITE_ENVELOPE_ENC` ≠ `'true'` |
| Brief 26 human gates cleared | `docs/brief26/THREAT_MODEL.md` still reads *"Draft for the §5 pre-production gates"* — the independent crypto review and the legal chain-of-custody review have **not** signed off |

(The 12 rows in `wrapped_keys` are acceptance-suite events, not real captures.)

Building anyway was an explicit call, taken with that stated: **build dormant behind the
flag, exactly as Brief 27 shipped**, so the work is ready the day Brief 26 arms — and keep
`/verification` **dark** rather than publishing a verification promise for documents that
cannot yet exist. The live `[L]` acceptance rows that need real commitments stay pending
until the flag is armed; everything provable without them is proven now.

---

## What was built

### §1 — Generation, on her device

- `apps/pwa/src/routes/settings/CertifiedReport.tsx` — the flow. Nothing runs before she
  taps. Auto-population is offered **after** that tap, opt-in **per report and per section**
  (recording / location / notifications), every one defaulting off.
- `apps/pwa/src/lib/report/evidence.ts` — the evidence zone. Her capture is decrypted
  **on-device** with **her** key via the shipped Brief 26 `capture-decryptor`, and every
  chunk is checked against the plaintext commitment recorded at capture time.
- `apps/pwa/src/lib/report/generate.ts` — orchestration. The evidence zone never leaves the
  device; only two SHA-256 hashes are sent for signature.

The capture summary is a **timestamped, chunked structural record** — per chunk: sequence,
time, size, whether it was encrypted, its commitment, and whether the decrypted bytes match
it. It is not a transcription and not an interpretation. **No model writes a fact about the
incident.** A chunk that fails its commitment is reported as failed, never dropped; a
missing final-chunk marker is stated, never smoothed over.

### §2 — The signature

Reuses the **shipped** Ed25519 integrity key (`INTEGRITY_SIGNING_KEY`, public half already
published at `/.well-known/blackbox-integrity-public-key.json`). No second crypto stack, no
second key system.

`workers/api/src/lib/report-attestation.ts` signs an attestation containing the two
device-computed hashes **plus facts the server re-derives from its own records**: the
capture-time commitments hash and the integrity-chain head.

> **This is the load-bearing design decision.** If the server signed only what the device
> sent, the certification would be circular — it would attest that the device said what the
> device said. Binding the server's own commitments hash and chain head makes the document
> check out against what BLACK BOX witnessed **at capture time**.

The server refuses to sign when the caller does not own the event, when there are no
capture-time commitments, or when no signing key is configured. A report that cannot be
honestly certified is not certified at all.

**What the signature does not claim** is written into the document, the verification page,
and `docs/brief29/VERIFICATION.md` §0: it attests to integrity and provenance, **not** that
the recording depicts anything in particular.

### §3 — Verification

- `packages/shared/src/report-verify.ts` — one verifier, used everywhere.
- `workers/api/src/lib/verification-page.ts` — the public page. **A leaf**: only the route
  registration references it, it is lazily imported, and it imports nothing operational.

The visitor's file is **never uploaded**. The page inlines the shared verifier (bundled by
`workers/api/scripts/build-verifier.mjs`) and checks the document in the browser. There is
no upload endpoint — so "the verifier never stores the uploaded document" is structural, not
a promise anyone has to take on faith.

Four honest verdicts: **CERTIFIED**, **TAMPERED**, **not a report**, and **could not
verify** — the last exists because a verifier that cannot tell "unaltered" from "I could not
check" would print reassurance on faith.

The page **pins the published key**. A document carries its own public key, so without
pinning a forger could re-sign an altered report with their own key and it would
self-verify. `verify.test.ts` proves exactly that attack is caught.

### §4 — Custody caution

Shown **before** the file is produced; `download()` is reachable from that screen and
nowhere else (guard-tested). It informs and does not discourage.

### §5 — Guards

Owner-scoped everywhere (`lib/report-metadata.ts` filters on `userId` in every query, and
mentions `orgId` nowhere). No org or operator route reaches a report. Settings/Visible only;
the Hidden facade is untouched.

---

## Purely additive — proven

```
apps/pwa/src/routes/settings/Settings.tsx |  25 +
packages/shared/src/index.ts              |   4 +
workers/api/src/index.ts                  |  26 +
workers/api/src/routes/user.ts            | 105 +
4 files changed, 160 insertions(+), 0 deletions(-)
```

**Zero deletions.** Trigger, capture, closure, dispatch, notification, accounts, tenancy,
entitlement, the envelope, and the intake are untouched. Full suite green after the brief:
**462 tests** (286 PWA + 176 worker), typecheck, lint, and build.

---

## Acceptance

Provable now, with the flag off:

- `[L]` **68** — every report endpoint 404s; `/verification` is not served (dormancy is real).
- `[L]` **69** — no anonymous access: the session check runs before the gate.
- `[L]` **70** — the published key still serves and the shipped manifest verifier still
  works, so independent verification is undisturbed.
- `[A]` Unit + guard proven: CERTIFIED vs TAMPERED (visible-text edit, JSON edit, swapped
  signature, re-signed forgery against a pinned key); statement edits never flag tampering;
  on-device decryption with real envelope primitives; deterministic evidence with no AI;
  leaf-ness; verifier stores nothing; signing key server-side only.

**Pending until the flag is armed** (they need real commitments, and cannot be faked):

- `[L]` Start a report → generic details auto-populate on opt-in, not before.
- `[L]` Evidence summary builds from on-device decryption; server never sees plaintext.
- `[L]` Unaltered file → CERTIFIED; one byte changed in the evidence zone → TAMPERED, **on
  the live page**.
- `[L]` Custody caution shown before download (on-device sign-off).

---

## Open gate items — not self-clearable

1. **Crypto review** must ratify that signing a device-computed hash (rather than the
   content) preserves zero knowledge, and must ratify signing-key custody and the
   publication of the verification public key. Carried in `docs/brief29/VERIFICATION.md` §6.
2. **Brief 26's own gates** — independent crypto review and legal chain-of-custody review —
   remain open. Brief 29 cannot be armed before Brief 26 is.
3. **`www.blackboxsentinel.com/verification`** is the address printed in every document. The
   page is currently served by the Worker origin and is dark. Routing that hostname is an
   ops step to take **at arming**, not before.
