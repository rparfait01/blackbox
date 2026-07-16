# BLACK BOX — FIX BRIEF 15 — Open-Module Build (PWA-scoped)

**Floor tag:** `known-good-2026-06-14-sec6` (do not regress below this)
**Mode constraint:** every row proven on the **deployed** app in **both** Present modes (covert + overt).
**Scope discipline:** surgical only. Touch what each section names. Before editing any shared/cross-module
file, stop and flag it in the section's notes — do not silently reach across module boundaries.

---

## 0. Module boundaries (enforce this separation)

These are the seams. A change inside one module must not require editing another's internals; cross-module
work happens only at the named contract (the API shape / event status), never by reaching into the other side.

| # | Module | Owns | Must NOT own |
|---|--------|------|--------------|
| 1 | Identity & Account | auth, contacts, guardian, settings, account lifecycle, permission grants | capture logic, alert state |
| 2 | Trigger | how an alert starts | what capture does after |
| 3 | Capture | audio/location acquisition + stream | who is notified |
| 4 | Alert Lifecycle | server-authoritative state machine + closure | channel delivery |
| 5 | Notification & Cascade | router + channels | coordinator roles |
| 6 | Coordination | election, dashboard roles, dispatch | evidence sealing |
| 7 | Custody & Data | D1 state, R2 evidence, signing, audit | UI |

If a task seems to need two modules' internals, the seam is wrong — flag it before coding.

---

## IN SCOPE (this brief)
A. Stillpoint facade palette (UI only)
B. Permissions priming at registration + denial handling
C. Permission-state monitoring + degraded-armed readiness (NEW — surfaced gap, included)
D. Identity & Account / Section 1
E. Closure upgrade — dual-consent push-button + queue + gesture duress + repetition/tampering + awaiting-timeout
   (preceded by E0 — closure integrity guarantees: server-truth, idempotency, no silent failure, ops-only force-close)
F. Custody integrity signing + evidence-export verify

## EXPLICITLY OUT OF SCOPE (do not build, do not stub beyond existing)
- Capacitor / native wrap — **paused** (Apple developer account unresolved).
- Native BLE listener, Web Bluetooth, BYO hardware triggers — gated on the wrap.
- Background audio/location capture while screen-locked/backgrounded — **not solvable in PWA**; do not
  pretend otherwise. Note the residual limitation to the user in Section C copy; do not engineer around it.

---

## SECTION A — Stillpoint facade palette  `[A]`  *(do first: isolated UI, zero logic, banks a clean green)*

**Module 1 (facade surface only).** The covert facade must read as a genuine, soothing breathing app —
not the instrument. Recolor the facade (login + dormant-covert) to a calm palette; leave the overt
instrument theme (true black / amber / red) untouched.

- Facade background: soft deep blue-green gradient (`#0a1d22 → #071416`), not true black.
- Facade accent: soft teal/aqua (`#8fd6cc` text, `#3f7d78` rings), gentle glow.
- Breathing orb: slow ease-in-out scale (4-7-8 cadence is fine), calming — never a pulse that reads as "alert."
- No amber, no red, no Mono "system voice" anywhere on the facade. It must look like wellness, full stop.

**Acceptance `[A]`:** covert screens render calm palette; overt screens unchanged (diff the overt theme — zero pixels moved). Activation gesture still works behind the facade. **Do not restyle the overt theme.**

---

## SECTION B — Permissions at registration  `[A→L]`

**Module 1 × Module 3 boundary.** Non-negotiable product rule: **the app never asks for a capture
permission during an emergency.** All grants are obtained at registration/onboarding.

- During onboarding, after contacts/guardian, request: **microphone, camera, geolocation** via a single
  clear priming step. (Web has no separate "recording" permission — recording = the mic/camera grant.)
- Each request preceded by one plain line of why (no marketing). On grant → green check, advance.
- On **deny**: do not silently proceed. Show exactly what's degraded and the OS path to fix it, and mark
  the account **not fully armed** until resolved. A denied mic = the system cannot do its core job; say so plainly.
- Persist grant state to the account so the dormant screen can reflect readiness without re-prompting.
- Re-verify (not re-prompt) on each app launch and on entering active state.

**Acceptance:**
- `[A]` onboarding cannot complete to "armed" without resolving the permission step (grant or explicit
  degraded-acknowledge).
- `[A]` denial path shows cause + fix, never a dead end, never silent.
- `[L]` after onboarding, a live activation reaches capture with **no permission prompt** appearing.

---

## SECTION C — Permission-state monitoring + degraded readiness  `[A]`  *(SURFACED GAP — included)*

**Why:** a permission granted at onboarding can be revoked later in OS settings. Without monitoring, the
system would fail silently in an emergency — the exact failure Section B exists to prevent. This closes the loop.

**Module 1 (readiness) → surfaces in dormant UI.**
- Add a `readiness` check: mic + location granted, (camera optional), contacts ≥ 1, last self-test ok.
- Dormant overt: when all green → `ARMED · LISTENING`. When a required permission is revoked → disc shows
  amber `!`, status reads **`NOT READY`** with the specific missing grant and a one-tap fix path.
- Dormant covert: readiness failures surface only through the hidden-gesture diagnostic, never on the facade.
- Pull-to-refresh self-test re-runs readiness end to end.

**Acceptance `[A]`:** revoke mic in OS settings → dormant reflects NOT READY within one launch/refresh; never silent. Re-grant → returns to ARMED.

---

## SECTION D — Identity & Account / Section 1  `[A]` + `[A→L]`

**Module 1, self-contained.** Complete account management.
- **Password login:** free-form password (no forced complexity theater); standard hashing server-side.
- **Forgot password:** secure single-use, expiring reset link via the account email; old sessions invalidated on reset.
- **Guardian slot:** server-side lock so the guardian cannot be changed/removed during an active event
  (same lock class as contacts/closure). Editable again only once secured.
- **Edit flows:** contact add/edit/remove with contiguous reindex (1,2,3 — never 1,3); guardian add/replace/on-off.
- **Delete account:** behind confirmation; wipes account + operational state. **Module 7 boundary:** evidence
  custody/audit retention follows the Custody policy (recordings wiped on request; audit metadata retained
  per legal posture) — call the Custody contract, do not delete R2 objects directly from the account code.

**Acceptance:**
- `[A]` login, reset (link issued → consumed once → reused link rejected), guardian lock during active,
  reindex correctness, delete-then-cannot-log-back-in.
- `[A→L]` reset link delivered on a real channel; guardian lock holds against a live active event.

---

## SECTION E0 — Closure integrity guarantees  `[A→L]`  *(Module 4 — build BEFORE E; the new closure sits on this)*

The "we can't have force-close scenarios" requirement. The stuck-active bug must be impossible by construction,
and the only recovery door must be ops-only — never user-facing. Land all four before the E rebuild.

- **Server truth only.** Client renders lock/active state from a `GET` of the event's server `status` — never
  from a client-held belief. If server says closed, the lock clears, full stop. No local "I'm active" flag that can desync.
- **Idempotent + retry-safe.** Confirm/secure transitions are idempotent: a request that lands server-side but
  times out client-side reconciles to the correct state on retry — never errors, never stacks, never traps.
- **No silent secure failure.** A failed confirm/secure (401, empty, non-200) shows the actor a plain reason
  and a live retry — never a dead button leaving the user locked.
- **Audited ops-only recovery.** Replace hand-edited prod D1 with `POST /admin/event/:id/close`, `ADMIN_TOKEN`-gated,
  writing an audit row (who, when, why). Never appears in the app; ops-only. This is the *only* force-close path.

**Acceptance:**
- `[A]` kill the client mid-close (drop network on confirm) → on reconnect the client reflects true server status; no stuck-active.
- `[A]` double-fire confirm → single clean result (idempotent), not a trapped or doubled state.
- `[A]` simulate a 401 on secure → actor sees cause + retry, never a silent lock.
- `[A→L]` admin endpoint closes a hung event, refuses without `ADMIN_TOKEN`, and writes the audit row.

---

## SECTION E — Closure upgrade  `[A→L]`  *(Module 4 — the heart; spec is locked, build to it)*

Replace the closure mechanic with the symmetric, consensus-gated design. **This is established design —
implement as specified; do not re-open the design.**

**E1. Symmetric dual consent + order-independent queue**
- Two roles (user, support/guardian) each have Request Closure / Confirm Closure. Either may act first;
  the first assent is **queued**, does not close. Alert closes only on the matching second assent.
- No passive GET, refresh, or link-scan is ever an assent.

**E2. Gesture-as-signal duress (user side)**
- Single closure control, invariant appearance. On-device gesture eval, **status only** transmitted.
- **Release < 3s → UNSAT (duress).  Hold ≥ 3s → SAT (clean).** Threshold clean, no dead zone.
- Both gestures land on the **identical** "Closure requested — awaiting confirmation" screen: no ring, fill,
  haptic, sound, or color difference. Assert + comment this invariant in code.

**E3. Repetition → tampering escalation (server-side, invisible)**
- Server counts UNSAT closure inputs per `event_id`; each is a timestamped audit row.
- Count ≥ threshold within window → disposition escalates `DURESS → TAMPERING/ESCALATING`: raise coordinator
  severity, advance/re-fire cascade per policy, log each repetition.
- **Single config** for threshold + window (default **≥2 within 120s**, tunable — Royce sets the final value).
- Device render is **identical for signal #1…#N**. No client-visible count. This is NOT the wrong-code
  lockout (typos lock out; valid duress escalates) — keep them separate.

**E4. Disposition over lifecycle**
- Consensus closes the lifecycle; the flag sets disposition. A DURESS/TAMPERING flag never closes "safe."
- While TAMPERING, an incoming support Confirm does not produce a clean close — responders stay engaged
  until a coordinator explicitly overrides **with cause, logged**.
- Closure report records `SAT | DURESS | TAMPERING`.

**E5. Awaiting-confirmation timeout fallback**  *(SURFACED GAP — see proposal P1; default below pending sign-off)*
- If a user clean-close request sits unconfirmed past a configurable window, do not trap the user: advance
  the confirmation request down the support chain (next contact → guardian) and surface the state. Default
  proposed: **re-prompt support at 60s, advance tier at 180s.** Hold for Royce's call before locking the policy.

**Acceptance:**
- `[A→L]` user-first and support-first both close only on agreement (queue holds the first).
- `[A→L]` UNSAT vs SAT produce identical device state; dashboard shows duress unmistakably; never "safe."
- `[A→L]` repeated UNSAT escalates to TAMPERING server-side with no device-observable change.
- `[A]` SAT/DURESS/TAMPERING written correctly to the closure report.

---

## SECTION F — Custody integrity signing + export verify  `[A]`  *(Module 7)*

- Sign closure reports + evidence packages with a server-held key; publish the public key for verification.
- `[A]` generate a package, verify the signature against the published key; tamper a byte → verification fails.
- No UI work here beyond a verify result in the existing export path.

---

## SURFACED GAPS — proposals for your call

- **P1 — Awaiting-confirmation timeout (in E5).** The dual-consent model can trap a user whose support is
  asleep/unreachable: their clean-close request hangs forever. Proposed: escalate confirmation down the
  chain on a timer. **Decision needed:** the timing, and whether an unconfirmed close may ever fall back to
  the emergency path. *Proposed-pending-decision.*
- **P2 — Post-activation grace window.** An accidental covert activation currently needs full dual-consent
  to clear. A short user-only cancel window right after trigger would ease fumbles — but it reintroduces a
  duress-bypass (an attacker forces cancel inside the window). **Recommendation: do NOT add it**; rely on
  dual consent + the coordinator's live read. Surfaced so it's a decision, not an omission.
- **P3 — Readiness on the lock screen / notification.** Surface NOT-READY as a quiet OS notification so a
  revoked permission is caught even if the user never opens the app. Low risk, high safety value.
  *Proposed-included if you approve; not built without your nod since it touches notification policy (Module 5).*

---

## DEFINITION OF DONE (per section, per governance)

A row is GREEN only when: it passes on the **deployed** app in **both** modes; its check is added to the
acceptance suite; **all previously-green checks still pass**; the work is committed; and MANUAL `[L]` rows
are signed off by Royce. Do not advance to the next section until the current one is committed green.
Tag a new `known-good-*` only after a full clean pass. Pre-push hook stays authoritative — no commit on red.

**Sequencing:** A → B → C → D → E0 → E → F. A is the warm-up (isolated UI). E0 must land before E (the new
closure is built on the integrity guarantees, not bolted after). E is the largest; do not start E0/E until
B/C/D are green, because the live tests depend on a clean account + permission + readiness baseline.
