# BRIEF 2 FIX A — DEVICE CREDENTIAL: AN IDENTIFIER IS NOT AN AUTHORITY

**Type:** FIX A on Brief 2 (custody — recipient identity and event authority)
**Priority:** P0 — event takeover
**REQUIRES:** Brief 30 Fix A green (§A registration binds to its capability); Brief 37 green (§B
verifies at its serialization point and uses its idempotency surface); Brief 33 Fix A and 35 Fix A
green.
**Ship order:** FIFTH.
**Floor:** Briefs 35–40, Brief 30 Fix A. **Zero regression to trigger latency.**
**Mode:** server-side build; device session required for final proof.
**Audit ref:** Pass 1 Finding 10 · Pass 2 Finding 10 (Confirmed — P0)

---

## CORRECTIONS

**BRIEF 002 §C1 — corrected to read:**
"Account identity is established by a credential the device holds and proves. A user identifier
is a lookup key and never an authorization: possession grants no ability to open, resume, or
write to an event."
Path: `workers/api/src/lib/auth.ts`

---

## THE DEFECT

`userHash` both identifies the account and authorizes event operations. Anyone who learns it can
open an event on that account, resume one, or write to it. It is long-lived, present in client
storage, and cannot be rotated without breaking the account.

In severity order: an abuser who has had the survivor's phone can open events on her account
afterward; a spurious event consumes the single-active slot and blocks a real trigger (the
phantom-active class already seen in production); false evidence is written into a genuine
event's chain.

---

## §0 — TRIGGER LATENCY IS THE CONSTRAINT

Measure before and after. **Any increase fails this brief.** A credential check must never stand
between a survivor and an alert. Where verification cannot be made free on the trigger path,
accept the event provisionally and reconcile asynchronously. Never gate.

## §A — PROVISION

- Device keypair at first run; private half non-exportable; public half registered to the account.
- Registration bound to an authenticated session (passkey or Brief 30 Fix A capability).
- Multiple devices per account, each independently revocable.
- **Provisioning lives in the identity boundary — never in the event DO** (Brief 37 §D).

## §B — PROVE

- Event-scoped writes carry a signature over method, path, event id, body digest, timestamp.
- Verified at the Brief 37 serialization point, using the idempotency surface built there.
- `userHash` remains a lookup key and stops being sufficient for any write.

## §C — REPLAY AND CLOCK

- Bounded timestamp window plus the Brief 37 idempotency key. State the window.
- Clock skew tolerance stated. **A skewed device must still trigger** — see §0.

## §D — RECOVERY AND REVOCATION

- Device lost or replaced: re-provision through the existing passkey/recovery path. **A survivor
  who loses her phone must be able to arm a new one the same day.** State the flow.
- Revocation is immediate and audited, and does not invalidate historical chain records signed by
  that device while valid (Brief 39 §C precedent).

## §E — ANTICIPATED GAPS

1. **Migration.** Existing accounts have no device credential. A cutover that requires one before
   the next trigger disarms every live user. Provision on next launch, accept `userHash` for
   writes until the account has a credential, then stop accepting it **per account** — never by a
   global flag date. Report per-account credential coverage on the readiness panel.
2. **Private browsing / cleared storage.** Non-exportable keys vanish. Re-provision silently
   through the existing session; never a dead end mid-event.
3. **Enforcement flag.** Ship dark, arm per account on evidence — the Brief 36 pattern. A global
   flag that reads armed while accepting `userHash` is the defect class this project has hit
   three times.
4. **The event DO boundary.** The DO validates event-scoped signed requests. It does not mint,
   store, rotate, or revoke identity. State this in the DO header comment.

---

## ACCEPTANCE

1. Trigger latency before and after. **No increase.** Both numbers reported.
2. Known `userHash`, no credential, account with coverage → cannot open, resume, or write.
   Screenshot the rejection.
3. Valid credential → full lifecycle: trigger, cascade, capture, closure.
4. Replayed signed request → no second effect.
5. Skewed clock (±) → still triggers.
6. Revoke a device → immediate; historical chain records still verify.
7. Re-provision on a second device; both work; each independently revocable.
8. Cleared storage mid-session → silent re-provision, no dead end.
9. Legacy account with no credential → still triggers, still dispatches, credential provisions on
   next launch. **This is the regression that matters most.**
10. Readiness panel reports credential coverage.
11. **Device session:** real trigger both Present modes, real delivery screenshot.
12. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Rate limiting. **Brief 41.** — Session rotation. **Brief 42.**
