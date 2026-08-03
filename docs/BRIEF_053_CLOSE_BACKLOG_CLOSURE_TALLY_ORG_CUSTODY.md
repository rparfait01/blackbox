# BRIEF 53 — CLOSE THE BACKLOG: CLOSURE, TALLY, ORG CUSTODY

**Type:** FIX + BUILD, three sections that share nothing but a ship window
**Priority:** §A is P0 and survivor-facing. §B and §C are P1.
**REQUIRES:** Brief 23 Fix A green (§C needs tenancy). §A and §B require nothing.
**Ship order:** **§A ships first and immediately — before Brief 33 Fix B, 50, or 52.** §B and §C
follow in this brief.
**Floor:** all shipped work. Zero regression to trigger, capture, cascade, closure, custody,
§0a facade.

---

> **WHY THIS BRIEF EXISTS**
>
> Three items have been carried forward by name with no verified status since Brief 34's
> reconciliation. Carrying a name is not owning a thing. This brief owns all three and closes them
> in one pass rather than one at a time.
>
> **Two corrections to the record, made here so they stop being repeated:**
>
> 1. **Brief 25 was never gated on tenancy or ZK.** Its own §1 says so: it holds no identified
>    data, so there is nothing to encrypt. It has been runnable the entire time and was listed as
>    blocked in error.
> 2. **Brief 26 is roughly half shipped.** Briefs 36, 37, 38 and 39 built the survivor half —
>    envelope encryption with a per-capture DEK sealed on-device, AAD binding capture id ‖ chunk
>    index ‖ final flag, a terminal marker in the chain, the `plaintext_commitments` table
>    answering review Q5, and a server holding only ciphertext, hash and wrapped keys. **The org
>    half is untouched**, and it is the half institutional licensing depends on. Calling Brief 26
>    "not started" was wrong.
>
> **Brief 27 remains blocked** and is not in this brief. It gates on Brief 26 proven in
> production, which §C does not complete on its own.

---

## §0 — VERIFY BEFORE BUILDING `[REPORT ONLY]`

**Report and stop before writing code for §A.**

1. **Brief 0B — confirm or refute:** dual-consent closure is hardcoded to 2, so a survivor with
   **no engaged second party cannot close her own event** and it runs to timeout. Show the code
   and the current closure path.
2. What are the actual closure paths today — user-initiated, dual-consent, feed-loss, orphan,
   admin force-close, lifecycle timeout? Which can a solo survivor reach?
3. **Brief 25** — is any of it built? Schema, endpoint, settings entry point.
4. **Brief 26 org half** — confirm against the code: org pubkey, DEK wrapped to org, per-seat
   wrapping of the org private key, seat offboarding rotation, release re-encryption, seat
   watermarking, location wrapped to org. Report each as present or absent.

If §0.1 confirms the defect, **§A preempts everything in the queue.**

---

# §A — CLOSURE SCALES (Brief 0B)

**P0. Survivor-facing. Ships alone if §0 confirms it.**

## A1 — The rule

**Consent scales to the parties actually engaged.** A closure requires agreement from the people
who are actually in the event — and if the survivor is the only one, her consent alone closes it.

- Solo survivor, no coordinator claimed → **she closes it herself.**
- Coordinator claimed → dual consent as today.
- More parties engaged → consent from the engaged parties, not a hardcoded number.

## A2 — Never a lockout

- A survivor must never be unable to end her own event. An event she cannot close is one she
  cannot make stop — on a device she may need to hand to someone.
- Per the standing rule, this comparison is on the closure path: **it fails toward the survivor
  being able to close.** Proven both ways before ship.
- Closure remains the survivor's exit from a live alert; nothing archival, encrypted, or sealed
  stands between her and it (Brief 40 §F2 precedent).

## A3 — What closure does not become

- Closure does not become a *quiet* path. An abuser holding the phone must not be able to close
  an event any more easily than today.
- The existing closure PIN and dual-consent behaviour for claimed events is unchanged — this
  section adds the solo path, it does not weaken the multi-party one.
- Every closure records who consented and how many parties were engaged at the time.

---

# §B — ANONYMOUS TALLY (Brief 25)

**Build to the brief as written. It is complete and correct; nothing here supersedes it.**

Four taps in Settings. Records **that** an incident occurred, not what happened.

## B1 — The non-negotiables, restated because they are structural

- **Severance is structural, not promised.** No foreign key, no join path, no derivation link to
  any account, device, capture, event, session, or org. Prove it by grep.
- **No free-text column exists.** Not optional, not hidden, not "notes."
- **Never auto-populated** from a capture or event. Auto-fill is a derivation path and a
  derivation path is a re-identification path.
- Submission **month**, never the instant.
- Rate-limit **per account**, but the counter lives on the account and the account id appears
  nowhere in the record. Limit the sender; store the record severed.
- Rate-limit rejection is stated honestly. **A survivor must never believe something was counted
  when it wasn't.**
- Per-submission consent showing the literal four values. No blanket consent, no default-on.
- Small-count suppression at publication, default ≥ 10.
- §0a: Settings-side only, never in the Hidden facade, **never surfaced during an active alert.**

## B2 — Anticipated gaps

1. **The rate limiter is now Brief 41's.** Use it. §0 of Brief 41 makes limits an allow-list — this
   route is added deliberately, and it is not on the alert path so limiting it is correct.
2. **Severance versus the tenancy work.** Brief 23 Fix A denormalised `orgId` onto evidence tables.
   **This store gets no `orgId` and no tenant attribution of any kind.** It is not evidence and it
   is not anyone's tenant data.
3. **A guard asserts severance**, not a comment claiming it. Any migration adding a foreign key,
   an account column, or a free-text column to this table fails the suite — the Brief 23 Fix A §B
   pattern.

---

# §C — ORG CUSTODY (Brief 26, the untouched half)

**Everything below is what Briefs 36–39 did not build.** The survivor half is done and is not
re-opened here.

## C1 — What is already shipped, for the record

Envelope encryption with per-capture random DEK, sealed on-device before transmission (Brief 36).
AAD binding capture id ‖ chunk index ‖ final-chunk flag, and a terminal marker recorded in the
chain (Brief 38). Signed pre-encryption plaintext commitment (review Q5). Server holds ciphertext,
integrity hash and wrapped keys only. Signer provenance pinned and reported (Brief 39).

## C2 — The org half

- **Org keypair.** DEK wrapped to the survivor's public key **and** the org's, per Brief 26 §2
  state 3.
- **Per-seat wrapping of the org private key** (review Q2). Every seat has its own keypair; the
  org private key is wrapped to each seat's public key; the server stores N wrapped copies and
  never the plaintext. **Never a shared secret.**
- **Seat key custody:** WebAuthn PRF extension over the seat's existing passkey, per the review's
  recommendation, with a stated fallback for authenticators lacking PRF. No new credential, no
  password.
- **Rotation and re-wrap (state 8).** Seat offboarding rotates the org key and re-wraps to
  remaining seats, performed client-side by a remaining authorized seat — the server cannot. The
  rotation event is signed by the performing seat and appended to the hash chain.
- **Release (state 7).** Survivor authorizes → re-encrypt to the named recipient's key → logged
  key-provisioning event. **Never a download-and-forward, never a standing copy.**
- **Watermarking.** Captures carry account/org/seat id so a leak traces to a seat.
- **Location wrapped to the org**, never server-plaintext (decision B).
- **Algorithm identifier stored per wrapped key** (review Q1) so X25519 is a config change rather
  than a migration.
- **Counter-based IV** — 32-bit random per-capture prefix ‖ 64-bit chunk counter (review Q4).
  Confirm what Brief 36 actually shipped; if it is random, correct it here and record the
  correction against Brief 36 §A.

## C3 — Say what is true

- **Disclosure copy must state that the organization can read the content** (review Q8). A
  survivor reading "BLACK BOX cannot read your captures" reasonably concludes nobody can. Her
  shelter can. Suggested wording is in the review; use it or better.
- **Retroactive revocation is partly theater** and the DPA says so plainly. Re-wrap stops future
  server-mediated access; it cannot un-see what a seat already saw. Watermarking and audit are the
  real control.
- **Timing and event state are operator-readable by design**, because closure and auto-close
  depend on them. Disclose it; claim no more than is true.

## C4 — The two gates that are not paperwork

Brief 26 §5 requires them and they are unmet:

1. **Independent crypto review** of primitives and envelope design before production code ships.
2. **Legal review of chain of custody** — is re-encrypted evidence admissible. Perfect crypto is
   not admissible evidence.

**§C ships flag-gated and dark until both clear.** Report what is needed to obtain each; do not
treat the review answers document as a substitute for the reviews.

## C5 — Anticipated gaps

1. **Mass re-wrap does not scale.** N captures re-wrapped client-side in one admin's browser is
   fine at pilot scale and painful at 5,000 seats. The alternative is an epoch-key hierarchy, with
   the trade-off that a departed seat who cached an epoch key retains access to their tenure's
   captures. **This is a reviewer decision, not CC's.** Report it; do not pick.
2. **Capture-path zero-regression outranks every encryption goal.** A survivor mid-event records
   during migration, behind the flag, in every failure mode.
3. **No custom crypto.** Established audited primitives only.
4. **Do not conflate operating and releasing.** The org key operates; the survivor's authority
   releases. Two powers, never one permission check.

---

## ACCEPTANCE

**§A**
1. §0.1 answered with code shown before any §A work.
2. Solo survivor with no coordinator claimed → closes her own event. Screenshot.
3. Coordinator claimed → dual consent unchanged.
4. Three or more engaged parties → consent scales, no hardcoded number.
5. Fail-open proven both ways: no configuration leaves a survivor unable to close.
6. Every closure records consenting parties and engaged count.
7. Closure is not made easier for someone holding the phone.

**§B**
8. Settings → four taps → submitted, under a minute.
9. Severance proven by grep: no FK, no join path, no derivation link, no `orgId`.
10. No free-text column in schema or UI. No auto-population path.
11. Guard fails any migration adding FK, account column, `orgId`, or free text.
12. Rate limit enforced per account; account id appears nowhere in the record.
13. Rate-limit rejection surfaced honestly, never a silent discard.
14. Consent screen shows the literal payload and states it cannot be withdrawn.
15. Small-count suppression demonstrated on a deliberately rare combination.
16. Unreachable during an active alert; §0a Hidden byte-identical.

**§C**
17. DEK wrapped to survivor **and** org. Server proven unable to decrypt.
18. Per-seat wrapping; N wrapped copies; plaintext org key never stored.
19. Seat offboarding → rotation → re-wrap → departed seat loses access to prior captures.
20. Release: survivor authorizes → re-encrypted to recipient → logged. No standing copy.
21. Watermark traces a capture to a seat. Every decrypt audit-logged.
22. Location wrapped to org, never server-plaintext.
23. Algorithm identifier stored per wrapped key. IV construction confirmed counter-based, or
    corrected here with the correction recorded against Brief 36 §A.
24. Disclosure copy states the org can read content.
25. §C is flag-gated dark; both §C4 gates reported as unmet with what is needed to clear them.
26. Capture path unregressed behind the flag — mid-event capture still records.

**All**
27. Trigger, capture, cascade, closure, custody unregressed. Full acceptance suite green.

---

## CARRIES FORWARD (open, owned by)

- **Brief 27 — guided intake.** Still gated on Brief 26 proven in production, which §C does not
  complete alone. Do not begin it.
- **Brief 24 — org registration**, the vetted invite-only front door for orgs beyond the pilot.
  Unblocked by Brief 23 Fix A; not scheduled.
- Brief 33 Fix B, Brief 50, Brief 52 — the standing queue, resuming after §A ships.
- Brief 51 — device session, Royce's phone.
- Double-tap gesture items.
