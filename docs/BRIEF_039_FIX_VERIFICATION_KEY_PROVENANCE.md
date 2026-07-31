# BRIEF 39 — VERIFICATION KEY PROVENANCE: A PACKAGE MUST NOT VOUCH FOR ITSELF

**Type:** FIX
**Priority:** P1 — blocks every origin and authenticity claim
**Gate:** Briefs 37 (`47e61a3`) and 38 (`98660d4`) shipped. A correct, complete chain verified
against a self-supplied key proves nothing, so this brief is the one that gives 37 and 38
their value.
**Floor:** Briefs 35–38. Zero regression to trigger, capture, upload, closure, export, the
deploy gate, readiness panel, cascade DO alarm, integrity DO, or bounded cron.
**Mode:** server-side and verifier-side. **No device dependency.**
**Audit ref:** Pass 1 Finding 4 · Pass 2 Finding 4 (Confirmed — P1)

---

## CORRECTIONS

**BRIEF 002 §C2 — corrected to read:**
"The verifier establishes signer identity from a trust root it carries independently of the
package under examination. A public key travelling inside an export is treated as an assertion
to be checked, never as the authority that checks it."
Path: `tools/verifier/`

**BRIEF 034 §5 (Chain of custody) — corrected to read:**
"Exports are signed, and the verifier reports which signer key validated them, by fingerprint,
against an independently held trust root."
*Effective only when this brief's acceptance is green.*

---

## THE DEFECT (settled — do not re-diagnose)

The export carries the signing public key alongside the signed material, and verification uses
the key it was handed. The check is therefore circular: any party able to produce a package can
produce a keypair, sign with it, bundle the public half, and obtain `VERIFIED`.

Nothing in the current output names *who* signed. A reviewer reading a verified export learns
that the bytes are internally consistent — not that they originated from this system.

This defeats the purpose of signing. Briefs 37 and 38 make the chain correct and complete;
without this brief, correctness and completeness are properties of a document with no
established origin.

---

## §0 — PRECONDITION: WHERE DOES THE TRUST ROOT LIVE `[A]`

Pinning moves trust from the package to whatever carries the pin. State plainly, before
building, which of these the design uses, and what the consequence is if that artifact is
substituted:

- **Embedded at build time** in the verifier binary. Trust root is the verifier's provenance.
- **Pinned well-known endpoint** with a hardcoded fingerprint. Trust root is the fingerprint
  constant, plus availability.
- **Both**, with the endpoint used only for rotation discovery and the embedded fingerprint
  authoritative.

Recommendation is the third. Whichever is chosen, the report states the residual trust
assumption in one sentence. Do not claim the assumption is eliminated — it is relocated, and
saying otherwise is the same class of overclaim §B of Brief 38 corrected.

## §A — PIN THE SIGNER `[A]`

- The verifier holds a set of trusted signer public keys independently of any package.
- A key present in a package is parsed, compared against the trust set, and **never** used as
  the verification authority.
- A package whose signer is not in the trust set does not verify. It produces a distinct
  outcome — see §D.
- The trust set is version-controlled and its contents are reviewable. No dynamic fetch that
  can silently widen it.

## §B — REPORT THE FINGERPRINT `[A]`

Verifier output names, in plain language:

- the signer key fingerprint that validated the package
- the signing timestamp
- whether that key was valid at the signing time

A reviewer must be able to read the output and state who vouched for the document. "Verified"
without an identified signer is not an improvement on unsigned.

## §C — ROTATION AND REVOCATION ARE DIFFERENT `[A]`

- **Rotation:** a signature made by a key valid at signing time remains verifiable after that
  key is retired. Historical keys are retained in the trust set with validity windows. A
  survivor's export from a year ago must not stop verifying because a key rotated.
- **Revocation:** a key marked compromised. Packages signed by it after the revocation instant
  do not verify; packages signed before it verify with an explicit notice.
- Rotation and revocation are recorded as operator actions with actor, timestamp, and reason.
  Neither is a silent config edit.

## §D — VERIFIER OUTCOMES `[A]`

Signer provenance is a fourth axis, independent of Brief 37's chain outcome and Brief 38's
completeness state. Do not fold it into either.

| Signer outcome | Meaning |
|---|---|
| `SIGNER_TRUSTED` | Signature valid, key in trust set, key valid at signing time |
| `SIGNER_UNKNOWN` | Signature internally valid but the key is not in the trust set |
| `SIGNER_REVOKED` | Key in the trust set but revoked before the signing instant |
| `SIGNATURE_INVALID` | Signature does not verify against the presented key at all |

`SIGNER_UNKNOWN` is the exact condition the defect allowed to pass as `VERIFIED`. It must be
visually and textually distinct in the output — not a footnote.

## §E — VERIFIER DISTRIBUTION `[A]`

- The verifier is a standalone artifact a third party can run without the platform.
- Publish it with a checksum. The checksum is the reviewer's entry point into §0's trust
  assumption.
- Its trust set and version are printed on every run, before any result.

---

## ACCEPTANCE

Server-side and verifier-side. No device required.

1. Genuine production export verifies: `SIGNER_TRUSTED`, fingerprint named, signing time
   named.
2. **The defect, proven closed:** construct a package signed by a freshly generated keypair
   with the public half bundled. Result is `SIGNER_UNKNOWN` — not `VERIFIED`. Screenshot.
3. Tamper with signed material under a trusted key. Result is `SIGNATURE_INVALID`.
4. Rotate a signer key. Packages signed before rotation still verify `SIGNER_TRUSTED` with the
   historical fingerprint.
5. Revoke a key. A package signed after the revocation instant returns `SIGNER_REVOKED`; one
   signed before returns `SIGNER_TRUSTED` with the notice.
6. All four axes render independently on one export: signer outcome, chain outcome (37 §E),
   completeness state (38 §D), and encryption state (36 §A). Screenshot a purged event showing
   `SIGNER_TRUSTED` · `PURGED_BY_CONSENT` · `ABNORMAL`.
7. §0's residual trust assumption is stated in the report in one sentence.
8. Verifier prints trust set version and checksum on run.
9. Full acceptance suite re-run, 90/90, all prior greens still pass.

---

## THIS BRIEF DOES NOT CLOSE

- Vault immutability and scan coverage. **Brief 40.**
- Whether the operator could sign a fabricated package with a genuinely trusted key. That is
  an operator-trust question, not a cryptographic one, and it is answered by the zero-knowledge
  custody model, not here. State the boundary; do not paper over it.
- Device credentials. **Brief 42.**
- Brief 36 acceptance item 12 (arming `REQUIRED`) and the outstanding device session.
