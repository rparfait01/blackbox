# BRIEF 24 — ORG REGISTRATION (vetted, invite-only, one-time admin code)

**Companion to Brief 23 (Tenancy). Build with or immediately before it — Brief 2's org portal has no front door
without this.**
**Org registration is NEVER self-serve.** An abuser registering a fake shelter to obtain coordinator-level access
to survivors is the worst-case compromise of the entire system. Human vetting is the control.

---

## §0 — RESOLVED DECISIONS (build exactly this)

| Decision | Answer |
|---|---|
| **Admin count** | **Minimum 2, enforced. No maximum.** The system refuses to drop below 2. An arbitrary cap only blocks someone at a bad moment |
| **License acceptance** | **Paid → signed out-of-band during vetting.** Zero-fee → click-through |
| **Verification evidence** | 501(c)(3) or state nonprofit registration **+** coalition directory listing, **then a call to a number obtained independently — never the number they supplied.** That independent callback is the control |
| **Coalitions** | **Flat org.** One org, many coordinators. No parent/child structure |

## §1 — THE FLOW

```
1. Org requests a briefing                    (public site — anyone)
2. HUMAN VETTING                              ← blocking, out-of-band, performed by Royce
3. Operator creates the ORG RECORD            (name, lane, seats, term — pre-filled, not user-editable)
4. Operator issues ONE-TIME ADMIN CODE + link (approval sent to the named individual)
5. Named individual registers admin #1        ← code consumed here, permanently
6. Admin #1 invites admin #2 from inside      (required — seats stay locked until 2 admins exist)
7. Portal is MANAGEMENT ONLY from here        (no registration path remains for this org)
```

- `[A]` Steps 2–4 are **operator-only**. No public form creates an organization.
- `[A]` **The org record already exists before the code is issued.** The code *claims the admin seat on a
  specific pre-created org* — it does not create an org. A stolen code cannot register "Fake Shelter Inc."
- `[A]` Org name, lane, seat count, and term are **read-only** on the registration page. The registrant confirms;
  they cannot edit.

## §2 — THE ONE-TIME ADMIN CODE

| Property | Value |
|---|---|
| Scope | **One org, `admin` role, first admin only** |
| Uses | **Single-use.** Consumed on successful registration, permanently |
| Bound to | The specific pre-created `organizations` row |
| Expiry | Required. Short (default 14 days) |
| Revocable | By operator, any time before redemption |
| Redemption attempts | **Rate-limited server-side** |
| Delivery | Code and link delivered **separately** — a forwarded approval email alone must not complete registration |
| Cannot | Create coordinators · enroll survivors · create a second admin · be reused · create an org |

- `[A]` This code type is **distinct from survivor/coordinator enrollment codes** (Brief 23 §4). A registration
  code can never confer a coordinator seat, and an enrollment code can never confer admin.
- `[A]` On redemption: mark consumed, timestamp, record who redeemed, write an audit entry. Store in
  `enrollment_codes` with a distinct `role = admin_registration`, or a dedicated table — **do not overload the
  survivor enrollment path.**

## §3 — ⚠️ PASSIVE-GET HAZARD (this will silently break it)

**Automated email link scanners will hit the approval link before a human ever sees it.** This exact failure has
already occurred in this codebase — a coordinator role was claimed on a passive GET before anyone acted.

- `[A]` **Registration must NEVER complete on page load.** Opening the link renders a form and nothing else.
- `[A]` The code is consumed **only on explicit user submission** — a deliberate POST after the human enters the
  code and completes passkey enrollment.
- `[A]` A GET on the registration URL must be **idempotent and side-effect-free.** No claim, no consumption, no
  state change.
- `[L]` Test it: fetch the link programmatically, confirm the code is still unredeemed and the org still has zero
  admins.

## §4 — THE REGISTRATION PAGE

Lives where accounts live. Reached only by the issued link.

| Element | Behavior |
|---|---|
| Org details | **Read-only.** Name, license lane, seats, term — pre-filled from the vetted record |
| Code entry | Manual entry. **Not pre-filled from the URL** (see §3) |
| Registrant identity | Name, work email |
| Authentication | **Passkey enrollment** — same passwordless mechanics as everywhere. No password. Recovery code issued once |
| License acceptance | Click-through, with attestation: *"I am authorized to accept this on behalf of this organization."* Record who accepted, when, and the license version |
| Submit | Explicit action. Consumes code, creates admin #1, writes audit entry |

- `[A]` No survivor-facing UI, no covert facade, no trigger anywhere in this surface.
- **RESOLVED — license acceptance:** **paid licenses are signed out-of-band during vetting** (the DPA lives
  there); registration is then purely technical. **Zero-fee shelters: click-through is sufficient.**
  `[A]` Record which path applied, who accepted/signed, when, and the license version.

## §5 — AFTER REGISTRATION: MANAGEMENT ONLY

- `[A]` The registration route is **dead for that org.** No path re-opens it from the portal.
- `[A]` Admin #1 lands in the org portal and is **prompted to invite admin #2 before anything else.**
- `[A]` **Seat issuance stays locked until 2 admins exist** (Brief 23 / Ops Spec requirement).
- Every subsequent admin and coordinator is added **from inside** by an existing admin — never by a registration
  code.

## §6 — ESCAPE HATCHES (or an org gets bricked)

| Failure | Recovery |
|---|---|
| Code expires unredeemed | Operator re-issues. Old code stays dead |
| Wrong person received it | Operator revokes before redemption, re-issues to the correct individual |
| **Admin #1 registers, then leaves before adding admin #2** | **Operator can issue a replacement admin registration code.** Without this the org is permanently stuck at one unreachable admin |
| Org drops to fewer than 2 admins later | System blocks removal of the second-to-last admin; if it happens by other means, operator re-issue path applies |

- `[A]` **Every operator re-issue is logged** with reason. This is a privileged action and the audit trail is the
  only control on it.

## ACCEPTANCE

- `[L]` Operator creates an org record and issues a one-time admin code; the link renders a form.
- `[L]` **Programmatic GET of the link does not consume the code or create an admin.** Prove it.
- `[L]` Registration completes only on explicit submission with a valid code + passkey enrollment.
- `[L]` The consumed code is dead — a second attempt is refused with a clear message.
- `[L]` Org name/lane/seats/term cannot be edited by the registrant.
- `[L]` Admin #1 is prompted to invite admin #2; **seat issuance is blocked until 2 admins exist.**
- `[L]` The registration route is unreachable for an org that has completed registration.
- `[L]` A registration code cannot enroll a survivor or create a coordinator; an enrollment code cannot create an
  admin.
- `[L]` Rate limiting on redemption attempts is enforced.
- `[L]` Operator re-issue path works and is logged.
- `[A]` §0a: no covert facade, no trigger, no survivor UI in this surface. Safety floor unregressed.

## DONE
Invite-only org registration behind human vetting, a single-use admin-only code bound to a pre-created org record,
consumption on explicit submission only (never a passive GET), passwordless admin enrollment with recorded license
acceptance, portal becomes management-only afterward, and operator escape hatches logged. Committed; both deploy
halves currency-asserted; sign-off.
