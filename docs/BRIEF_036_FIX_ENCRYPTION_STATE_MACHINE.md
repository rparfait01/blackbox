# BRIEF 36 — ENCRYPTION STATE MACHINE: NO PLAINTEXT LEAVES THE DEVICE

**Type:** FIX
**Priority:** P0 — RELEASE BLOCKER
**Floor:** Brief 35 shipped (`a098327`). Zero regression to trigger, closure, check-in,
live-alert lock, cascade, §0a facade, **and the Brief 35 deploy gate**.
**Mode:** proven on deployed production, both Present modes, on a real capture.
**Audit ref:** Pass 1 Finding 11 · Pass 2 Finding 11 (Confirmed — P0)

---

## CORRECTIONS

*Ordered newest brief first, matching the reading order in Brief 34 §1.*

**BRIEF 035 §D — corrected to read:**
"Dispatch suppression requires two conditions, both re-derived server-side at dispatch time:
the event's `isTest` flag and the owning account's `isCanary` flag. Either condition alone
dispatches normally and raises an operator alert. `isCanary` is immutable after provisioning;
a canary account may hold only reserved-range contacts."
Path: `workers/api/src/lib/notify.ts`

**BRIEF 035 §C — corrected to read:**
"The canary reserved contact number is `+14155550199`. The reserved block is exchange 555
with line range 01XX."
Path: `config/deploy-targets.json`

**BRIEF 035 §C — corrected to read:**
"The canary resolves the deployed version through the same fail-closed poller the currency
check uses. A single `/version` read is not sufficient — a colo mid-rollout answers staler
than the publish."
Path: `scripts/deploy-pages.mjs`

**BRIEF 034 §5 (Encryption) — corrected to read:**
"Capture is encrypted before transmission. Plaintext chunks are not reachable on any path."
*Effective only when this brief's acceptance is green. Until then the Brief 34 §5 reading
stands and no document may state that capture is encrypted.*

**BRIEF 026 §CUSTODY MODEL — corrected to read:**
"No evidence chunk transmits from the device in any state other than READY. Encryption is a
precondition of transmission, not a best-effort enhancement applied when available."
Path: `apps/pwa/src/lib/upload/upload-manager.ts`

**BRIEF 026 §CUSTODY MODEL — corrected to read:**
"The alert path — event creation, contact dispatch, location, heartbeat, closure — never
reads encryption state and is never delayed by it. Confidentiality governs evidence chunks
only. A survivor mid-event is notified-for and located regardless of encryption status."
Path: `apps/pwa/src/lib/activation/index.ts`

**BRIEF 026 §CUSTODY MODEL — corrected to read:**
"Every chunk carries a server-verifiable encryption state. The server rejects a chunk whose
declared state does not match the account's encryption policy."
Path: `workers/api/src/index.ts`

---

## THE DEFECT (settled — do not re-diagnose)

`openEvent()` launches `prepareEncryptor(ctx)` **without awaiting it**, then returns true.
Queue draining can call `sendItem()` immediately. Until key fetch, DEK generation, wrapping,
and wrapped-key upload all complete, `ctx.encryptor` is null and `sealChunkForSend()` returns
the plaintext unchanged. The server accepts and stores it without requiring encryption
metadata, even with its own flag armed.

**This is not an exceptional path.** The asynchronous initialization creates a race on
ordinary timing — early chunks of a normal capture upload in plaintext. Any later failure
(missing survivor public key, key endpoint failure, wrapped-key upload failure, WebCrypto
throw or timeout) leaves the entire capture plaintext.

The deployment is described as encryption-armed. Mixed plaintext and ciphertext are the
expected outcome.

---

## §A — THE STATE MACHINE `[A]`

One capture-scoped encryption state. Explicit, persisted, never inferred from the presence
or absence of a key object.

| State | Meaning | Chunks may transmit |
|---|---|---|
| `PREPARING` | Key setup in flight | **No** |
| `READY` | Encryptor established and proven | **Yes** |
| `FAILED_RETRYABLE` | Transient failure; retry scheduled | **No** |
| `FAILED_TERMINAL` | Cannot encrypt for this capture | **No** |

- Transitions are one-way except `FAILED_RETRYABLE → PREPARING → READY`.
- `FAILED_TERMINAL` is terminal for the capture. It never resolves to `READY`.
- The state is set from a single owner. No other module writes it.
- Prove the encryptor before declaring `READY` — a self-test round trip, not merely a
  non-null object.

## §B — THE TRANSMISSION RULE `[A]`

- `sendItem()` reads the state. Anything other than `READY` means the item is not sent and
  remains queued on-device.
- Delete the plaintext passthrough in `sealChunkForSend()`. A null encryptor is a
  programming error and throws — it is not a fallback.
- Server side: when the account's encryption policy requires encryption, a chunk arriving
  without valid encryption metadata is **rejected with 4xx**, not stored. The server does not
  rely on the client to enforce this.
- Persist the encryption state per chunk, server-side, from what the server itself observes —
  not from a client assertion.

## §C — THE ALERT PATH IS NEVER GATED `[A]`

Explicitly verify and pin with a regression check:

- Event creation, contact cascade, location updates, heartbeat, and closure execute on their
  own path and never read encryption state.
- A capture in `PREPARING` or `FAILED_TERMINAL` still produces a live event, a full cascade,
  and a located survivor.
- Trigger latency is unchanged. Measure it before and after; report both numbers.

**If any part of this brief adds a single millisecond to trigger dispatch, the
implementation is wrong.**

## §D — STORAGE-FAILURE DEGRADATION POLICY `[A]`

Buffering on-device only works if the device can store. Without this section the policy
becomes "confidential but silently lost," which is a worse failure than plaintext.

Define a capture-level safety-degradation state, distinct from encryption state:

| Condition | Result |
|---|---|
| State not `READY`, buffering **succeeds** | Held on device. Normal. No user signal. |
| State not `READY`, buffering **fails** | **DEGRADED — EVIDENCE AT RISK.** Declared, surfaced, logged. |
| `FAILED_TERMINAL` + buffering fails | **DEGRADED — EVIDENCE NOT RETAINED.** Declared, surfaced, logged. |

Surfacing:

- **Overt mode:** an explicit, plain-language warning. The survivor is told her recording may
  not be retained. Honest-status is a locked principle — never indicate retention that is not
  happening.
- **Covert mode:** a covert-safe signal that does not break the facade. Define it in this
  brief and name it in the report. The facade never breaks; the signal must still be
  perceptible to someone who knows to look.
- **Server side:** the degradation state is reported with the event so the coordinator view
  and the eventual report both reflect it.

The alert itself is unaffected in every one of these states. Contacts are notified. Location
flows. Only evidence retention is degraded, and only the evidence claim is withdrawn.

## §E — POLICY SURFACE `[A]`

- A per-account encryption policy: `REQUIRED` (default) or explicitly relaxed.
- Relaxation is an operator/account-level decision recorded in an audit row with actor and
  timestamp. It is never a silent runtime fallback.
- The report states, per capture, which policy applied and which state was reached.

## §F — CANARY COMPATIBILITY (gap surfaced by Brief 35) `[A]`

Brief 35 §C ships a canary that uploads 64 synthetic bytes on every deploy. Once §B lands,
that upload meets the same server-side rejection as any other chunk. Two failure modes to
foreclose:

- **The canary must not bypass encryption.** An exemption would make the deploy gate stop
  proving anything about the path that actually carries evidence. The canary account holds
  its own keypair and its synthetic payload traverses the real encryption path end to end.
- **The canary must not break the deploy.** If the canary cannot reach `READY`, the deploy
  fails with a message naming the encryption state — not a generic upload failure. A deploy
  that cannot encrypt is a deploy that must not publish.

The canary therefore becomes the standing per-deploy proof that the encryption path is live.
That is a strictly better gate than the one Brief 35 shipped, and it is why §F sits here
rather than being deferred.

## §G — CLOSE THE SUPPRESSION SYMMETRY (gap surfaced by Brief 35 §D) `[A]`

Two-condition suppression is tight against a stray `isTest` but not against a stray
`isCanary`. Make the unsafe state unrepresentable rather than improbable:

- `isCanary` is written once at provisioning and immutable thereafter. Any change is an
  audited operator action with actor, timestamp, and an alert.
- A canary account may hold contacts only in the reserved range. A canary account with a
  routable contact fails at startup, not at dispatch.
- The existing `canary_flag_on_non_canary_account` alert gains its mirror,
  `routable_contact_on_canary_account`, also at error level.

---

## ACCEPTANCE

Each proven on the deployed app, both Present modes, on a real capture with real audio.

1. Normal capture: every chunk transmits encrypted. **Zero** chunks with plaintext state in
   D1. Query and screenshot the rows.
2. Force key-endpoint failure. Capture continues, chunks queue locally, **nothing
   transmits**, state is `FAILED_RETRYABLE` then `FAILED_TERMINAL`. Confirm no plaintext
   reached R2.
3. Server rejects a hand-crafted unencrypted chunk against a `REQUIRED` account. 4xx, not
   stored.
4. Timing race: trigger and immediately produce chunks. Confirm no chunk transmits before
   `READY`. This is the specific ordinary-path defect — prove it directly.
5. Alert path unaffected in every state above: live event, full cascade, contacts actually
   receive, location present. **Screenshot a real delivery.**
6. Trigger latency measured before and after. Report both.
7. Degradation: deny IndexedDB, force encryption failure. The overt warning appears; the
   covert signal appears; the server records the degraded state; the alert still fires.
8. **Canary:** a full deploy runs, the synthetic payload traverses the real encryption path,
   and the deploy succeeds. Query the canary chunk row and confirm it is encrypted.
9. **Canary fail-closed:** break the canary's key path. The deploy **fails**, naming the
   encryption state. Nothing publishes.
10. **Suppression symmetry:** attempt to mutate `isCanary` on a provisioned account — refused
    and audited. Attempt to add a routable contact to the canary account — refused at
    startup. Both alerts fire at error level.
11. Full acceptance suite re-run, all prior greens still pass — **including the Brief 35 gate
    and the cascade-timing check, which is diagnosed rather than tolerated before this brief
    is marked done.** If the timing variance is genuinely harness jitter, the tolerance is
    pinned to a stated number and the reasoning recorded. If it is not, it is a P0 and it
    preempts this brief.

---

## THIS BRIEF DOES NOT CLOSE

- Queue byte budgeting, dead-letter handling, and quota telemetry. **Brief 44.** This brief
  owns the degradation *contract*; 44 owns queue *management*.
- The terminal-chunk marker, which shares this encryption AAD pipeline. **Brief 38.**
- Integrity chain correctness. **Brief 37.**
- Brief 35 acceptance item 7 — a real production trigger in both Present modes — remains open
  and is not discharged by anything in this brief.
