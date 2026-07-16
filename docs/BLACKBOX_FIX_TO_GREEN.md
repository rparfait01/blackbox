# BLACK BOX — FIX TO GREEN (Zero-Regression Work Orders)
Paste one section at a time into Claude Code. Do not start a section until the prior one is committed (or its remainder logged). Greens are off-limits.

---

## GLOBAL STANDING HEADER — applies to EVERY section
```
ZERO REGRESSION. Do not change what already works. Surgical only: touch the named function, nothing else; flag before touching shared code.
Do NOT modify safe-area values. Do NOT move toggles or change ranges already set. Do NOT restyle anything.
Do NOT assume — determine the ACTUAL state on the DEPLOYED app and report it. If unknown, say "unknown." Never guess.
Add/confirm the regression CHECK in the suite BEFORE the fix.
Run BOTH covert and overt where applicable. Prove on the DEPLOYED app with real responses — never "tests pass."
If a row needs a real product/architecture decision, STOP and log it — do not decide silently.
```

### WHAT CONSTITUTES GREEN  *(universal — every row, every section)*
A row is GREEN only when **all six** hold:
1. Its CHECK passes on the **deployed** app.
2. Proven in **both covert and overt** (where applicable).
3. The CHECK is **added to the acceptance suite** (permanent tripwire).
4. **Every previously-green check still passes** (no new casualty).
5. The work is **committed**.
6. **MANUAL rows signed off** by the human, then the section is **tagged `known-good-<date>` and pushed.**
AUTO = Claude Code runs it. MANUAL (device/visual/real-delivery) = human signs off; never marked green from an automated run.

### SECTION SEQUENCING  *(strict)*
Finish + commit a section before the next. If a row can't cleanly reach green (blocked / needs decision / needs device / unverified): do everything that CAN be done precisely, commit that, **log the remainder to the Cumulative Report**, then move on. No row left unaccounted for.

---

## SECTION 1 · ACCOUNT MANAGEMENT
STANDING RULES APPLY. **Leave green, do not touch:** Create account, Add contacts, Remove contacts, Delete account.

- **Edit account (🟡):** edit name/nationality → reload → trigger → value renders in alert payload (no hardcoded strings). CHECK: "edited name persists across reload AND renders in a triggered alert." Both modes.
- **Login password (build):** user-chosen **free-form** password (not a pin). Screen: **Sign In** button (current create-account size), **Create an account** button below it (slightly smaller), Sign In → username + password → **Forgot password** link below. CHECK: "free-form password sets + authenticates; old rejected after change; Sign-In/Create/Forgot all present."
- **Forgot password (build):** emails a **secure reset link** → user sets a new password (reusing same password allowed). CHECK: "reset link emails + works; expired/used link rejected."
- **Guardian slot (🟡):** active-event lock enforced **server-side**. CHECK: "toggle works dormant; edit rejected by server during active event."
- **Closure pin (verify):** stays ONE permanent 3-digit pin — closure-only, not per-session, NOT a login credential. (Login-wiring check lives in Section 6.)

**GREEN WHEN:** all four CHECKs pass on deployed (both modes), added to suite, no green regressed, committed + tagged.

---

## SECTION 2 · CONTACTS & CHANNELS
STANDING RULES APPLY. **Leave green:** Slot model, Channel select/deliverability, LINE QR pairing.

- **Router priority (🟡):** trigger with a failing channel on an early slot → router falls through in priority order, no halt. CHECK: "fail early channel → next channel fires, order preserved."

**GREEN WHEN:** the router CHECK passes on deployed, added to suite, no green regressed, committed + tagged.

---

## SECTION 3 · TRIGGER & ACTIVATION
STANDING RULES APPLY. Determine real deployed state — do NOT assume. **V0 capture scope = audio + location ONLY** (no video; video stays gated behind hardware).

- **Mandatory recipient (🟡):** arm with zero filled slots → blocked **server-side**. Add server guard only if missing (surgical). CHECK: "arm with zero recipients → server-rejected."
- **Arm (🟡):** armed/ready state both modes. CHECK: "arm → ready, covert + overt."
- **Activate + capture (determine → build if missing):** trigger on deployed both modes; REPORT whether audio + location actually start. If missing → build to audio+location scope as its own surgical step. CHECK: "trigger → one event with live audio + location."
- **One active event (🟡):** trigger twice fast → single event. CHECK: "second trigger creates no second active event."

**GREEN WHEN:** all four CHECKs pass on deployed (both modes), capture state reported, added to suite, no green regressed, committed + tagged.

---

## SECTION 4 · CASCADE & NOTIFICATION
STANDING RULES APPLY. **Leave green, do NOT re-tune:** Timing (DO alarm 0/10/20/30/40), Fail-advance, Delivery + audit.

- **Slot collapse (🟡):** real-timestamp runs — (a) guardian+emergency only → +0/+10; (b) emergency only → +0. CHECK: "Nth filled slot fires at (N−1)×10s; empty slots consume no window." Do not alter the all-filled path.

**GREEN WHEN:** collapse CHECK proven with real timestamps, added to suite, all-filled timing untouched + still green, committed + tagged.

---

## SECTION 5 · COORDINATOR & RESPONSE
STANDING RULES APPLY. **Leave green:** Claim, Claim-halts-cascade.

- **Access tiers (🟡):** coordinator = full (audio/location/share); others = location-only. CHECK: "coordinator full; others location-only."
- **Coordinator ≠ pin (🟡):** coordinator surface shows SAT/UNSAT only, no pin field. CHECK: "no pin input on coordinator surface; status only."

**GREEN WHEN:** both CHECKs pass on deployed, added to suite, no green regressed, committed + tagged.

---

## SECTION 6 · CLOSURE & DURESS  *(LIVE P0 — DO THIS FIRST)*
STANDING RULES APPLY. Fix + lock the gate FIRST, CHECK before fix. Closure secret = the single permanent 3-digit pin (no shape, no second secret). This regressed twice — every row gets a permanent check. Do NOT touch unrelated closure code.

- **Safe close gate (🔴 P0):** ADD CHECK FIRST → "active alert + NO pending user code-request → contact has NO path to end it (secure/end unavailable or rejected)." Then bisect what regressed it; restore the gate (SECURE inert unless a user code-request is pending).
- **Pin not transmitted (🟡):** network trace on real closure → pin value never leaves device (status only). CHECK: "no request contains the pin value."
- **Pin not wired to login (🟡):** pin cannot authenticate login; retire any legacy pin-as-password path. CHECK: "pin rejected as login; login requires password."
- **Duress (🟡):** last-digit-altered → duress; awaiting screen identical to safe close. CHECK: "duress vs safe = identical screen; duress flagged to coordinator." *(visual = MANUAL)*
- **Typo lockout (🟡):** wrong-not-duress 3× → lockout + coordinator notify. CHECK: "3 wrong → lockout + notify."
- **One-close-door (🟡):** refresh user app mid-event → still open (only coordinator secures). CHECK: "refresh during active event → still open."
- **Operator force-close (🟡):** admin force-close works + audit entry. CHECK: "force-close → audited entry."

*Parked enhancement (after green, own bite, pin-compatible): closure **reason** field + coordinator **call-first** before securing (covers non-emergency cases). Not part of this pass.*

**GREEN WHEN:** gate CHECK passes (contact cannot close with no pending request) on deployed both modes; all six remaining CHECKs pass; duress screen-identity signed off (MANUAL); all added to suite; no green regressed; committed + tagged. **This tag is the new floor.**

---

## SECTION 7 · DASHBOARD & AUTHORITY
STANDING RULES APPLY. Do NOT restyle. Several rows are MANUAL.

- **Render order (🟡, MANUAL):** map → origin → situation → audio → transcript → controls. CHECK: "renders in spec order."
- **Frozen origin t=0 (🟡):** move after trigger → origin stays t=0. CHECK: "origin unchanged after movement."
- **Emergency locale (🟡):** JP → 110/119. CHECK: "region → correct number."
- **DTG + timer (🟡, MANUAL):** 60s watch → DTG correct, timer no runaway. CHECK: "timer sane 60s, DTG correct."

**GREEN WHEN:** all four CHECKs pass on deployed; MANUAL rows signed off; added to suite; no green regressed; committed + tagged.

---

## SECTION 8 · CHECK-IN ("I'M OK")
STANDING RULES APPLY. Do NOT alter the dormant-only rule.

- **Location link (🔴):** ADD CHECK FIRST → "check-in location is a working map link." Then render location as a proper map link. *(AUTO: valid map URL. MANUAL: it opens.)*
- **Reassurance ping (🟡):** sends dormant, no session, unavailable during active event. CHECK: "available dormant; unavailable during event; no session."

**GREEN WHEN:** both CHECKs pass on deployed; link-opens signed off (MANUAL); added to suite; no green regressed; committed + tagged.

---

## SECTION 9 · EVIDENCE & CUSTODY
STANDING RULES APPLY. Now DEFINED. First REPORT the existing module's real state (it was partially built), then reconcile to this spec. Own bite — do NOT mix with other fixes; sequence after the core suite is green.

- **Recipient gate:** download blocked until recipient provides first name · last name · organization · **government email** · title. System records **acquisition date+time** automatically.
- **Grants:** local authorities download **plus one optional attorney** download. No more without a new grant.
- CHECK: "download blocked until all fields + gov email; acquisition timestamp recorded; max one authority + one optional attorney grant; same data → same hash."

**GREEN WHEN:** existing state reported; recipient gate + grant limits + timestamp + hash CHECKs pass on deployed; added to suite; committed + tagged.

---

## SECTION 10 · PLATFORM & DELIVERY
STANDING RULES APPLY. **Leave green:** PWA install, SW self-update, Deploy, Git/tags.

- **Safe-area gear (🟡, MANUAL, EYEBALL ONLY):** human opens home-screen-installed PWA → gear clear of battery/signal. **NO code change** (fix already in). If still hidden, report before touching anything. CHECK (MANUAL): "gear reachable on installed app."

**GREEN WHEN:** human confirms gear clear on installed app; no code touched; logged + tagged.

---

## SECTION 11 · REGRESSION GOVERNANCE
STANDING RULES APPLY. **Leave green:** the suite's own rule.

- **Acceptance suite (🔴):** provide MAGIC_LINK_SECRET via gitignored .acceptance.env + CI secret store (coordinator checks need it). Tag every row AUTO/MANUAL. Build all AUTO checks into the suite, fail-closed, run on every commit vs deployed. Output MANUAL checks as a release checklist. `known-good` tag requires human MANUAL sign-off. CHECK: "suite green on deployed; coordinator checks run in CI."

**GREEN WHEN:** AUTO suite runs on every commit vs deployed and is green; coordinator checks run in CI; MANUAL checklist exists; committed + tagged.

---

# CUMULATIVE REPORT  *(fill as you go)*

## PART A · LOGGED REMAINDERS
Per row: **row · why not green** (blocked / needs decision / needs device / unverified) **· exactly what's left.**

## PART B · DECISIONS — RESOLVED
- **Login:** free-form password; Sign-In + Create + Forgot-password restored.
- **Closure secret:** ONE permanent 3-digit pin; not per-session; not a login credential; last-digit = duress; never transmitted. **Shape rejected** (lower-entropy/learnable duress, broke never-transmitted, and safe+duress shapes = two secrets — the thing being avoided).
- **Recovery:** Forgot-password = secure reset link (not plaintext password — passwords are hashed/irretrievable; emailing plaintext is unsafe). Reusing same password allowed.
- **Capture:** audio + location only (no video).
- **Evidence:** recipient gate (name/org/gov-email/title + acquisition time; authorities + one optional attorney).
- **Release gate:** known-good tag requires human MANUAL sign-off.
- **Kept from shape musing:** closure reason + coordinator call-first (pin-compatible, parked enhancement).

No open decisions block the work. Start with **Section 6**.
