# BRIEF 26 — DATA CUSTODY: ZERO-KNOWLEDGE REBUILD

**GATE: do not begin until Brief 23 (Tenancy) has shipped and is stable.**
**THE RISKIEST BUILD IN THE PROJECT. Isolated. Flag-gated. Nothing stacked on it.**
**Capture-path zero-regression outranks every encryption goal.** A survivor mid-event still gets their capture
recorded — during migration, behind the flag, in every failure mode. No exceptions.

**Scope:** custody and encryption only. The guided intake tool is Brief 27 and does not begin until this is proven
in production.

---

## LOCKED PRINCIPLE (not re-litigable)

- **The incident record belongs to the user.** It is never a BLACK BOX asset — not raw, not derived, not
  anonymized.
- BLACK BOX tracks **operational counters only**: activations, licenses, coverage. Never content.
- The published customer commitment says we do not sell, mine, or monetize incident content.
  **This brief exists to make that structurally true rather than merely promised.**
- "I have storage access" must mean **"I have blobs I cannot open."**

---

## §1 — CUSTODY MODEL (locked)

| Party | Power | Never |
|---|---|---|
| **Survivor** | Owns the capture. Holds a key. Always. **Releases.** | — |
| **Organization** (the org, not an individual coordinator) | Holds a key to **operate** — live decrypt to run a response. Any authorized seat operates via the org key. | Cannot independently distribute |
| **Operator / server** | Stores ciphertext + integrity hash + wrapped keys. | **Never holds a readable key. Never decrypts. No standing content access.** |
| **Authorities / courts** | Receive evidence only by survivor-authorized re-encryption, logged. | **Never a standing copy** |

**Operating ≠ releasing.** The org key operates. The survivor's authority releases. Two distinct powers — never
conflated in code, never collapsed into one permission check.

**Why the ORG key and not a coordinator key:** the responding coordinator is elected *after* an event begins, and
the survivor may be incapacitated. Access cannot be granted in the moment. Encrypt to the org; authorized seats
operate through it.

---

## §2 — THE CUSTODY FLOW, END TO END (the stabilized process — implement exactly this)

| # | State | What happens | Who can read | Server holds |
|---|---|---|---|---|
| 1 | **Created** | Capture produced on device | Device only | nothing yet |
| 2 | **Sealed** | Encrypted **on-device before it leaves**; per-capture random data key | Device only | nothing yet |
| 3 | **Wrapped** | Data key wrapped to survivor pubkey **and** org pubkey | — | nothing yet |
| 4 | **Stored** | Upload ciphertext + integrity hash + wrapped keys | nobody server-side | ciphertext, hash, wrapped keys |
| 5 | **Operated** (live) | Elected seat's client unwraps via org key, decrypts to run the response | that seat, client-side | unchanged |
| 6 | **Reviewed** | Survivor or authorized seat unwraps client-side to review | survivor / authorized seat | unchanged |
| 7 | **Released** | Survivor authorizes → re-encrypt to the recipient's key → logged provisioning event | named recipient | unchanged + release log |
| 8 | **Revoked** | Seat offboarded → **org key rotation → re-wrap** → departed seat loses access to prior captures | remaining seats | re-wrapped keys |
| 9 | **Deleted** | Survivor deletes → ciphertext destroyed; audit metadata retained per policy | nobody | hash + audit metadata only |

**Invariants that must hold at every state:**
- `[A]` No data key in clear, and no private key, exists server-side at any point in the flow.
- `[A]` Every decrypt (states 5, 6, 7) is **audit-logged**: who, what, when.
- `[A]` Release (7) is a **logged key-provisioning event**, not a download-and-forward.
- `[A]` Transient plaintext exists only on an authorized client during 5/6/7 — inherent, bounded, logged.
- `[A]` Captures are **watermarked** with account/org/seat id so any leak traces to a seat.
- `[A]` State 8 is **required, not optional.** A departed seat retaining decrypt access is a failure.

---

## §3 — ARCHITECTURE

- Envelope encryption. Per-capture random data key. Encrypt on-device pre-transmission.
- Data key wrapped to survivor pubkey + org pubkey (`org_pubkey`, reserved in Brief 23). Wrapped keys stored
  alongside ciphertext.
- Decrypt = client-side unwrap only. Private keys are client-custodied and never reach the server readable.
- **Established, audited primitives only** (WebCrypto / libsodium). Standard constructions. **NO custom crypto.**
  Final primitive selection is validated at the crypto-review gate — not assumed from this brief.
- **Location must remain operable by a coordinator** → wrapped to the org key, never server-plaintext.

---

## §4 — DECISIONS (RESOLVED — build exactly this)

| # | Decision | Answer |
|---|---|---|
| A | **Survivor key loss** | **Org-enrolled: org-mediated re-provision** — the org already holds an operating key, so this costs no additional custody. **Individual: recovery code only.** Lose the device and the code and it is gone — state this plainly at setup |
| B | **Metadata scope** | **Location → wrapped to org.** **Timing / event state → operationally clear** (closure logic and the auto-close backstop require it). **Contact graph → wrapped** |
| C | **Retroactive** | **New captures only.** Migrating existing captures puts risk on the most safety-critical path for little gain at pilot scale |
| D | **Re-encryption authority** | **Survivor only**, with **per-instance delegation** to a named coordinator — logged and revocable. No standing delegation |

`[A]` B is the ZK boundary in practice: timing and event state are readable by the operator **by design**, because
closure and auto-close depend on them. Say so plainly in the disclosure — do not claim more than is true.


## §5 — PRE-PRODUCTION GATES (hard blocks, not paperwork)

1. **Threat model written first.**
2. **Independent crypto review** of primitives + envelope design before any production code ships.
3. **Legal review: chain of custody.** Is re-encrypted evidence admissible? **Perfect crypto ≠ admissible
   evidence** — if the custody process isn't legally sound, the encryption is moot for the courts path.
4. **Flag-gated rollout** with proven capture-path zero-regression.

A failure here has three severe outcomes: the survivor's evidence is lost forever, the zero-knowledge claim is
false, or a coordinator cannot decrypt to run a live response. Treat accordingly.

---

## ACCEPTANCE

- `[A]` Server holds only ciphertext + hash + wrapped keys. **Prove the server cannot decrypt.**
- `[L]` A capture is decryptable by the survivor client-side and by an authorized org seat — and by nobody else.
- `[L]` All nine flow states behave per §2, with invariants holding at each.
- `[L]` Seat offboarding + org-key rotation revokes that seat's access to prior captures.
- `[L]` Release: survivor authorizes → re-encrypted to recipient → logged. No standing copy created.
- `[L]` Live capture path unbroken behind the flag — a mid-event survivor's capture still records.
- `[A]` Every decrypt audit-logged; captures watermarked to a seat.
- `[L]` Trigger / closure / notification / lock / currency unregressed. §0a Hidden byte-identical.

## DONE
Zero-knowledge custody live behind a flag, the nine-state flow implemented and proven, operator provably unable
to read content, four decisions answered before build, three pre-production gates cleared. Committed; `pnpm
deploy` with both halves currency-asserted; phone sign-off.

**Brief 27 does not begin until this is proven in production.**
