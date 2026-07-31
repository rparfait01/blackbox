# Brief 29 — ARMING RUNBOOK

**Run this ONLY at final acceptance, on a test account, after Phases 1–5 of the full
acceptance pass. Do not arm before the on-device safety-floor pass. Arming is the last gate,
deliberately.**

Brief 29 is built, committed, and pushed (`6e55a7e`), **dormant**. This document is the
sequence that arms it, plus the state of each precondition as last verified.

---

## Precondition check — verified against prod 2026-07-25

**All four are FALSE. Per the brief's own instruction: STOP. Do not arm.**

| # | Condition | Prod reality | Status |
|---|---|---|---|
| 1 | Brief 26 pre-production gates cleared | `docs/brief26/THREAT_MODEL.md` still reads *"Status: Draft for the §5 pre-production gates"* — no crypto reviewer or legal chain-of-custody sign-off recorded | ❌ |
| 2 | Survivor keys provisioning works | `users.pubkey` = **0 rows**; `users.recoveryWrappedKey` = **0 rows** | ❌ |
| 3 | Capture-time commitments write | `plaintext_commitments` = **0 rows**, across **4,002** rows in `chunks_index` | ❌ |
| 4 | Round-trip proven | proven in unit tests only (`capture-decryptor.test.ts`, `evidence.test.ts`); never on prod, because nothing has ever been encrypted there | ❌ |

Also note `chunks_index.isFinal` = **0 rows set**. The terminal-marker plumbing is the
deferred Brief 26 item, so until it lands every certified report will honestly state
*"Final-chunk marker present: false — the end of this recording may be incomplete."* That is
correct behaviour, not a bug, but expect to see it on the first armed report.

**Re-verify these on prod at arming time. Do not trust this table or memory.**

```sh
npx wrangler d1 execute blackbox --remote --json --command \
 "SELECT (SELECT COUNT(*) FROM users WHERE pubkey IS NOT NULL) AS pubkeys,
         (SELECT COUNT(*) FROM plaintext_commitments) AS commitments,
         (SELECT COUNT(*) FROM chunks_index WHERE isFinal=1) AS final_markers;"
```

---

## Blockers beyond the four preconditions

### A. Brief 29 is not deployed

Live worker is `11670b7`; the report code is `6e55a7e`. `/verification` on the Worker origin
404s today because **the route does not exist there yet**, not because the flag is down.
Deploy before arming, and re-confirm the 404 is then coming from the flag gate.

### B. Brief 30 (standalone verifier) does not exist

Arming step 5 says to verify the generated document *"against the standalone verifier
(Brief 30)"*. There is no Brief 30 in the repo. Until it exists, use the shared verifier
(`packages/shared/src/report-verify.ts`) or the procedure in
[VERIFICATION.md](./VERIFICATION.md) §3. Both target the same locked format.

### C. `www.blackboxsentinel.com/verification` is NOT dark — and it currently overclaims

The closing directions describe this hostname as dark, to be routed at arming. **It is live
now** and returns 200: a Squarespace page titled *"BLACKBOX CERTIFIED"* with a nav entry
"Verification". Its copy reads:

> "Drop in a report file. This page checks its cryptographic signature against BLACK BOX's
> public key and tells you one of two things: ✓ CERTIFIED … ✗ TAMPERED …"

The tool underneath it is an **empty Squarespace Embed Block** — *"REPORT VERIFICATION TOOL
— Embed Block — Add an embed URL or code."*

So the page promises a verification service and delivers nothing. Two problems, and the
first one is live **today**, independent of Brief 29:

1. **It overclaims to the public right now.** A court, advocate, or police intake officer
   who visits reads a confident description of an independent check and finds a placeholder.
   Nothing can be verified. This is the exact failure §0 exists to prevent — BLACK BOX
   asking to be believed rather than providing something checkable.
2. **It states only two outcomes.** The shipped verifier has four, and the extra two are the
   honest ones: *not a BLACK BOX certified report* (an unrelated file), and *could not
   verify* (no Ed25519 in this runtime). A verifier that collapses "I could not check" into
   CERTIFIED or TAMPERED is worse than none. The page copy must be corrected to match.

Arming step 6 is therefore **replace a live, overclaiming page**, not *route a dark
hostname* — and the copy fix is worth doing before then, on its own.

---

## Arming sequence (test account only)

1. **Provision the survivor keypair** on the test account (onboarding uploads `pubkey`).
   Confirm the row exists.
2. **Arm `ENVELOPE_ENCRYPTION_ENABLED`** for that account's scope only. Others unaffected.
3. **Capture on device** (real mic, covert activation — the human pass). Confirm:
   - `plaintext_commitments` gets rows;
   - stored capture is ciphertext and the server cannot decrypt it;
   - `[L]` **fail-open still holds** — force encryption to fail, capture still lands.
4. **Generate a report** (Brief 29 flow) and confirm:
   - generic details auto-populate **on opt-in**, not before;
   - the evidence summary builds from **on-device** decryption;
   - the evidence zone signs; the document carries the CERTIFIED mark + the verification URL;
   - the statement zone is hers — unsigned, editable;
   - the custody caution shows **before** download.
5. **Verify the generated document:**
   - unaltered → **CERTIFIED**;
   - alter one byte of the evidence zone → **TAMPERED**;
   - edit only the statement zone → **still CERTIFIED**.
6. **Route `www.blackboxsentinel.com/verification`** to the live verifier, replacing the
   Squarespace placeholder (see blocker C). It must resolve to a working verifier before any
   real report is generated for a real survivor. Ops step, not a code change.

## Fail-closed check — the paired invariant

- `[L]` Capture fails **OPEN** — encryption fails, capture still records.
- `[L]` Case file / report fails **CLOSED** — sealing fails, it refuses; no plaintext report
  is ever written.

Opposite by design. **If either inverts, stop — P0.**

## Non-regression

- `[L]` Full existing acceptance suite green with the flag ON for the test account.
- `[L]` Trigger, capture, closure, dispatch, notification, accounts, tenancy, entitlement —
  unchanged for every non-armed account.
- `[L]` §0a Hidden facade byte-identical.
- `[L]` Disarm the flag → reverts to plaintext cleanly; no corruption, no orphaned state.

> On disarm: a capture that was encrypted while armed **stays** encrypted, and its report
> stays verifiable. Disarming stops new encryption; it does not and must not retroactively
> decrypt. "Reverts cleanly" means new captures are plaintext again and nothing is stranded
> — not that prior ciphertext is undone.

## After a clean armed pass

- Tag known-good.
- Rollout scope: test account → pilot (Dominick) → general. **Staged, never all at once.**
- The verification hostname stays routed; the standalone verifier stays live.

---

## Order of operations — do not reorder

```
on-device safety-floor pass (Phases 1–5)
  → Brief 26 gates cleared
  → deploy Brief 29 (currently unshipped)
  → arm flag on ONE test account
  → capture on device → commitments write
  → generate report → CERTIFIED
  → route /verification (replacing the placeholder page)
  → fail-open + fail-closed pair proven
  → full suite green, flag on
  → disarm reverts clean
  → tag → staged rollout
```
