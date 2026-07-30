# BRIEF P0 — CLOSE THE GAPS (capture survival · solo closure · account access)

**PRODUCTION. LIFE-SAFETY. Three grouped fixes, each root-cause, each proven on a real device before the next.
No patches. No rapid-fire. Restore point before any prod migration.**

Standing constraints apply. §0a Hidden byte-identical. Trigger never taxed or gated. Both halves
currency-asserted. Prove every [L] on the real deployed device, not row counts.

**Order (dependencies): GROUP A (capture) → GROUP B (closure) → GROUP C (access). Do not interleave.**

---

# GROUP A — CAPTURE SURVIVES EVERYTHING (device-truth, local-first)

**The principle: capture is DEVICE-truth, not server-truth. The recording lives on the phone the instant the
trigger fires — before any network call — and survives no-signal, offline, app-kill, and server failure. The
server is how it gets DELIVERED, never whether it EXISTS. This is the core product promise: the moment she needs
it is the moment there's no signal.**

- `[A]` Trigger fires → capture begins writing to **durable local storage on the device immediately**, with zero
  dependency on event-creation or any server response succeeding.
- `[A]` Server event write fails / offline / no signal / smashed connection → capture continues locally,
  uninterrupted. Nothing is lost, nothing is blocked.
- `[A]` App killed mid-capture (offline) → reopened → the local capture is still there and resumes/persists.
- `[A]` On reconnect, reconciliation **DELIVERS** the orphaned local capture: re-persist the event server-side,
  upload the media, THEN clear local only **after delivery is confirmed**. Delivery first, clear second — always.
- `[A]` Reconciliation that clears a phantom/closed alert must **NEVER discard undelivered local media.**
  Un-delivered capture is sacred until confirmed uploaded.
- `[A]` Capture start adds **no latency** to the trigger. The button still always fires instantly.

**[L] PROOF (real device):**
- Trigger with server unreachable → records locally → reconnect → delivered → then cleared. Nothing lost.
- Kill app mid-capture while offline → reopen → local capture intact → delivers on reconnect.
- Trigger with a failing DB write → capture still records locally and delivers later; UI never shows a false
  "recording" over a void (honest-status holds), but the CAPTURE itself is never lost.

---

# GROUP B — A PERSON WITH NO CONTACT CAN CLOSE (solo closure, at the root)

**The principle: closure consent scales to parties actually ENGAGED. No contact / none engaged → the survivor
closes ALONE, immediately. This is Brief 0B — confirm it holds and fix wherever it doesn't. Delivery is not
engagement.**

- `[A]` A solo event with **no support contact / none engaged** → the survivor closes it **alone, immediately,
  no "awaiting confirmation," no waiting on a party that does not exist.**
- `[A]` Engaged coordinator/support present → dual-consent still required (anti-coercion preserved). The instant
  a support party actually engages, both consents return.
- `[A]` "Engaged" = an explicit action taken on the event (claimed/opened/acted), **never** mere delivery/notify.
- `[A]` Closure evaluates the **derived engaged-party set** server-side and atomically — no hardcoded dual
  consent, no `if(solo)` special case. One closure model.
- `[A]` A persisted event is always closable. With Group A + the shipped server-truth fix, there is no closable-
  over-nonexistent-event deadlock.
- `[A]` The 2h dark/unclaimed auto-close backstop remains untouched as the net for a truly abandoned event.
- `[A]` Clear any currently stuck phantom/awaiting-confirmation alerts on affected accounts.

**[L] PROOF (real device):**
- Solo account, zero contacts, trigger → END ALERT closes immediately. No awaiting-confirmation.
- Contact notified but never engaged → still closes solo (delivery ≠ engagement).
- Coordinator actually engages → dual-consent required; survivor alone cannot close. No double-close race.
- Existing stuck alerts cleared.

---

# GROUP C — NO MORE LOCKOUTS (passkey + email link, by design, survivor-safe)

**The principle: two factors everyone always has — their device (passkey) and their email (link). No dependency
on a recovery code that can be lost in a chaotic life. AND a compromised email must not hand an abuser the safety
account — so the email link RE-ENROLLS a passkey on a device; it does not silently grant a live session.**

## C1 — Email link works as a real fallback (fix the lockout cause)
- `[A]` The current rule that **blocks email-link entirely when a passkey exists** is the lockout cause. Replace
  it: an email link is **always available** as a recovery path, even when a passkey exists.
- `[A]` **Threat-safe design:** the email link does NOT drop the user straight into an armed live session.
  It authorizes **enrolling a new passkey on the current device.** The newly enrolled passkey becomes the working
  key. This means: a survivor who lost her device recovers; an abuser who compromised her email cannot silently
  seize her live session — enrolling a new device is visible and notifiable, not a silent takeover.
- `[A]` A new-device enrollment via email link **notifies existing enrolled devices** ("a new device was added"),
  so a survivor sees an unexpected enrollment. (If no other device exists, the enrollment proceeds — she has no
  other way in — but it is logged.)

## C2 — Passkey portability / second device (prevent the lockout, don't just recover from it)
- `[A]` At setup and after first sign-in, **strongly prompt to add a second passkey / backup device.** One device
  failing must not be a lockout. This is the primary prevention — the cross-device sync (Google↔iOS) is
  unreliable and must never be the only path.
- `[A]` Signing in on a new device offers passkey enrollment for THAT device, so each device holds its own
  passkey rather than depending on cross-ecosystem sync.

## C3 — Recovery code demoted, not required
- `[A]` The recovery code remains available but is **no longer the load-bearing fallback.** Passkey + email-link-
  re-enrollment cover recovery. Do not lock anyone out for lacking a recovery code.

## C4 — Operator reset (unblock developer@ now)
- `[A]` Reset `developer@blackboxsentinel.com` auth server-side so Royce regains access: clear the stale passkey
  credential and permit a one-time email-link enrollment so a fresh passkey can be enrolled on each device.
  Restore point first. Confirm it is the operator account.

**[L] PROOF (real device, cross-device):**
- Account with a passkey → request email link → link arrives → completes → enrolls a new passkey on this device
  → signed in. (No more "blocked because passkey exists.")
- New-device enrollment notifies existing devices.
- Add a second passkey on a second device → both devices sign in independently, no cross-sync dependency.
- developer@ recovered and re-enrolled on laptop AND phone.

---

# CROSS-CUTTING (all three groups)
- `[A]` Trigger always fires, ungated, zero added latency — no group touches the trigger hot path.
- `[A]` §0a Hidden facade byte-identical; none of this renders a tell.
- `[A]` Honest status throughout: never claim protection/delivery/recording that isn't real; never trap in one
  that isn't there.
- `[A]` Server is source of truth for STATE; device is source of truth for CAPTURE. Hold both.

# REPORT
GOOD / BAD / CORRECT-FOR-REPAIR, per group. Root cause named per fix. Real-device proof per [L]. List every
write/catch audited in A. Restore point ids. Deployed hash, both halves asserted. Any gap found mid-fix is closed
in-group or named explicitly — no dangling flags.

---

# GROUP C-0 — PASSKEY SIGN-IN IS BROKEN IN PRODUCTION (fix before the rest of Group C)

**Enroll succeeds, authenticate FAILS — "That didn't work" on every attempt, same device, same account that
worked before. This is the PRIMARY auth method broken in production: every user who enrolls a passkey then cannot
sign in with it. Root-cause the WebAuthn failure; do not patch around it, do not tell users to use email forever.**

**This runs FIRST within Group C — the rest of Group C assumes passkey works as primary.**

- `[A]` Capture the ACTUAL WebAuthn failure from both sides — the browser ceremony (navigator.credentials.get)
  and the server verification. Name the real cause on evidence, not a guess. Likely candidates to rule in/out:
  - **RP ID / origin mismatch** — passkey registered under one origin (e.g. pages.dev vs a custom domain, or
    www vs apex) and authenticated under another. WebAuthn binds to RP ID; a mismatch fails every time.
  - **Credential ID / public key mismatch** — the stored credential doesn't match what the authenticator returns
    (wrong encoding, truncation, or a schema change).
  - **Challenge verification** failing server-side (stale/absent challenge, signature check wrong).
  - **Orphaned/corrupted credentials from the account reset or a recent migration** — did the operator reset or a
    migration drop/alter the stored passkey rows so existing credentials no longer verify?
- `[A]` **Timeline check:** confirm whether sign-in broke AFTER the recent account reset / migrations. If existing
  passkey credentials were orphaned by that work, that is the cause — and it means real users' enrolled passkeys
  may be dead too.
- `[A]` Fix the root so **enroll and authenticate are symmetric** — whatever is stored at enrollment is exactly
  what verifies at sign-in, under a stable RP ID.
- `[A]` If credentials were corrupted/orphaned in prod, state how many accounts are affected and how they
  recover (this is why C1 email-link-reenroll must work — it's the safety net while passkeys are re-established).

**[L] PROOF (real device):**
- Enroll a passkey → sign OUT → sign IN with that passkey → succeeds. On laptop AND phone.
- The exact failing case from today (developer@, this laptop) now signs in with passkey.
- Confirm the RP ID is stable and correct for the production origin(s) users actually hit.
- Report whether any existing prod accounts had dead passkeys and their recovery path.

**Dependency:** C-0 is diagnosed and fixed before C1/C2/C3 build on top — but C1 (email-link re-enroll) and C4
(operator reset) may proceed in parallel since they are the recovery path that gets users back in while passkeys
are fixed. C4 unblocks Royce immediately via email link (already working) so the passkey diagnosis can be done
from a signed-in state.
