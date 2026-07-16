# BLACK BOX — FIX BRIEF 16 — Consent, Escalation & Notifications

**Floor tag:** `known-good-2026-06-24-brief15` (do not regress).
**Mode:** every row proven on the **deployed** app (production), **both** Present modes.
**Hard rule for this brief:** NO item may be deferred, descoped, or "simplified" without first
surfacing a *factual* break or regression to Royce and getting his call. Coordinator-initiated-only
closure and email-per-event are the exact regressions this brief exists to remove — do not reintroduce them.

Build the whole sequence this pass. Commit each section when its acceptance passes AND full regression
is still green. Pre-push hook authoritative. Deploy to PRODUCTION (master → blackbox-pwa.pages.dev + worker).
Do not pause between sections for sign-off. Stop only at the end for the phone checklist.

---

## SECTION 1 — Pin fully removed (confirm + excise)  `[A]`

Royce physically had to enter a pin — so the legacy lockCode path is still gating closure, not "vestigial."
This is a regression against §E2. Remove it.

- Find every server path that requires/validates a `lockCode` / pin in finalize, standdown, or secure.
- Closure is **gesture-only end to end**: hold ≥3s = clean (SAT), release <3s = duress (UNSAT). No code,
  no pin, no random auto-filled lockCode satisfying a legacy contract. Update the finalize contract itself
  so it no longer takes a lockCode.
- Onboarding sends no lock code. Nothing in either mode ever prompts for a pin.

**Acceptance `[A]`:** grep the codebase — no lockCode/pin gate remains in the closure path. `[L]` full
close flow (covert + overt) completes with the gesture only; no pin entry appears anywhere.

---

## SECTION 2 — E1: symmetric, order-independent dual consent  `[A→L]`  *(mandatory — not deferred)*

The core of the architecture. Either role may initiate; neither closes alone; order does not matter.

- **Both roles** (user, support/guardian) can issue Request Closure and Confirm Closure.
- **First assent — from either side — is queued** (pending), does not close.
- Alert closes **only on the matching second assent** from the other role.
- No passive GET / refresh / link-scan is ever an assent.
- The user's assent carries the gesture-derived status (SAT/UNSAT); a duress/tampering flag sets disposition
  and never yields "safe" regardless of which side initiated.

**Acceptance `[A→L]`:** user-initiated→support-confirms, AND support-initiated→user-confirms, both close
only on agreement; whichever acts first is held pending; neither side closes unilaterally; duress flag
survives either initiation order.

---

## SECTION 3 — E5: corrected escalation (guardian as foundational backstop)  `[A→L]`

Consent stays intact at every tier — escalation only changes *who the qualified confirmer is*.

**Hierarchy:** primary → secondary → tertiary → **guardian**. Coordinator = whoever claimed (pri/sec/ter).

1. User requests closure → routes to **coordinator**. Standard dual consent.
2. Confirmation prompts go to the **coordinator only** — no broadcast of the timeout to other contacts.
3. **60s** → reprompt coordinator. **180s** without confirm → coordinator path declared failed.
4. **User is notified the coordinator closure path failed** and is **prompted to request closure a second time.**
5. The **second request routes immediately to the guardian.** Only the guardian may confirm at this tier.
6. The second request is a fresh deliberate user action → **same gesture logic applies** (clean vs duress).
   The guardian **inherits the duress/tampering disposition** — escalation must not launder a duress flag away.
7. Guardian confirms → dual consent satisfied (user's second request + guardian confirm). Close with disposition.

**Emergency services = notification only:**
- No closure authority, no consent role.
- Live feed continues until it physically cannot (device dark / stream lost).
- When the feed stops, the session closes with a mandatory final note, verbatim:
  **"Safety is at risk. Session closure is NOT an indication of safety."**
- Closure report disposition records this distinctly from a consented SAT close.

**Acceptance `[A→L]`:** coordinator non-response at 180s → user gets failure notice + second-request prompt →
routes to guardian → guardian confirm closes; duress on the second request carries through; emergency-services
notify path never exposes a close control; feed-loss closure writes the exact note.

---

## SECTION 4 — Notification overhaul: one email, lifecycle in-app  `[A→L]`  *(Module 5 × 6)*

Email is for *reaching* someone not yet in the app. Everything after is in the dashboard, live.

- **Initial cascade unchanged for first-reach:** pri → sec → ter → guardian, ~15s apart, on real channels
  (email / SMS / LINE). This is the "reach a human who isn't in the app" step. Keep it.
- **Exactly ONE email per event: "Alert Triggered"** — its job is to deliver the dashboard link and pull the
  contact in. (Each cascade tier still gets their first-reach message; no contact gets a *second* email for
  lifecycle events.)
- **All lifecycle events move in-app, server-pushed to the open dashboard, live:** close request, close
  confirmation, actual closure, **duress, tampering escalation.** No emails for these — ever.
- **Mechanism:** the open dashboard subscribes to the event and updates on state change (server push, not
  polling, not re-emailing). The coordinator who's watching sees a duress/tampering signal the instant it
  fires — not buried in an inbox.
- **Safety rationale (build to it):** a duress signal in an unopened email is worthless. In-dashboard live
  state is the safety requirement, not just an anti-spam nicety.

**Acceptance `[A→L]`:** one activation → contacts receive their first-reach message only; opening the link
shows the live dashboard; close request / confirm / closure / duress / tampering all appear in the dashboard
in real time with **zero additional emails sent** (verify send logs).

---

## SECTION 5 — Emergency-services views (two paths)  `[A]`

- **Direct share** (coordinator shares with emergency services): full **live dashboard**, same as coordinator.
- **Escalation-path notification** (reached via the hierarchy): a **structured, dispatch-formatted event
  summary** — CAD-ready: subject, location with multi-format coordinates, frozen origin + last-known,
  threat read, nearest resources, witness callback, organized for fast dispatch consumption.
- Rule: direct share = live dashboard; escalation notification = structured summary push.

**Acceptance `[A]`:** direct-share token renders the live dashboard; escalation notification renders the
structured summary; both log every access; tokens expire after the event.

---

## DEFINITION OF DONE
Each section: passes on the **deployed** production app in **both** modes; check added to the acceptance
suite; all previously-green checks still pass; committed. After the full sequence, deliver ONE consolidated
phone checklist (both modes, all sections). Tag `known-good-*` only after Royce signs off on his phone.
No `known-good` tag, and no deferral of any section, without his explicit word.
