# BRIEF 29 — CLOSING DIRECTIONS (arming, at final acceptance only)

**29 is built, committed, pushed, DORMANT. These are the steps that arm it — run ONLY at final acceptance, on a
test account, after Phases 1–5 of the full acceptance pass.**
**Do not arm before the on-device safety-floor pass. Arming is the last gate, deliberately.**

---

## PRECONDITION — the gate 29 declares (must all be true before arming)

| # | Condition | Verify on prod, not memory |
|---|---|---|
| 1 | Brief 26 pre-production gates cleared | threat model, crypto review, legal chain-of-custody review — all signed off |
| 2 | Survivor keys provisioning works | `users.pubkey` populates on the test account |
| 3 | Capture-time commitments write | `plaintext_commitments` accrues rows on a real encrypted capture |
| 4 | Round-trip proven | encrypt → store → decrypt → commitment verifies (Brief 26 review-decrypt) |

If any is not true, stop. 29 verifies documents built from these; without them it signs nothing real.

---

## ARMING SEQUENCE (test account only)

1. **Provision the survivor keypair** on the test account (onboarding uploads `pubkey`). Confirm the row exists.
2. **Arm `ENVELOPE_ENCRYPTION_ENABLED`** for that account's scope only. Others unaffected.
3. **Capture on device** (real mic, covert activation — the human pass). Confirm:
   - `plaintext_commitments` gets rows.
   - Stored capture is ciphertext; server cannot decrypt.
   - `[L]` **Fail-open still holds** — force encryption to fail, capture still lands.
4. **Generate a report** (Brief 29 flow):
   - Generic details auto-populate on opt-in.
   - Evidence summary builds from on-device decryption.
   - Evidence zone signs; document carries the CERTIFIED mark + the verification URL.
   - Statement zone is hers, unsigned, editable.
   - Custody caution shows before download.
5. **Verify the generated document:**
   - Against the standalone verifier (Brief 30) → **CERTIFIED.**
   - Alter one byte of the evidence zone → **TAMPERED.**
   - Edit only the statement zone → **still CERTIFIED.**
6. **Route `www.blackboxsentinel.com/verification`** to the live verifier — this hostname is printed in every
   generated document and is currently dark. It must resolve before any real report is generated for a real
   survivor. (Ops step — part of arming, not a code change.)

## FAIL-CLOSED CHECK (the paired invariant)

- `[L]` Capture fails **OPEN** — encryption fails, capture still records.
- `[L]` Case-file / report fails **CLOSED** — sealing fails, it refuses; no plaintext report is ever written.
- These are opposite by design. If either inverts, **stop — P0.**

## NON-REGRESSION (prove arming changed nothing else)

- `[L]` Full existing acceptance suite green with the flag ON for the test account.
- `[L]` Trigger, capture, closure, dispatch, notification, accounts, tenancy, entitlement — all unchanged for
  every non-armed account.
- `[L]` §0a Hidden facade byte-identical.
- `[L]` Disarm the flag → system reverts to plaintext cleanly, no corruption, no orphaned state.

## AFTER A CLEAN ARMED PASS

- Tag known-good.
- Decide rollout scope: test account → pilot (Dominick) → general. Staged, never all at once.
- The verification hostname stays routed; the standalone verifier (Brief 30) stays live.

---

## ORDER OF OPERATIONS (do not reorder)

```
on-device safety-floor pass (Phases 1–5)
  → Brief 26 gates cleared
  → arm flag on ONE test account
  → capture on device → commitments write
  → generate report → CERTIFIED
  → route /verification
  → fail-open + fail-closed pair proven
  → full suite green, flag on
  → disarm reverts clean
  → tag → staged rollout
```

**Brief 30 (standalone verifier) ships independently and can go live before this — it verifies test documents
until 29 produces real ones. Both target the same locked format.**
