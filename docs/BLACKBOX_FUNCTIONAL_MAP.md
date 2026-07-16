# BLACK BOX — FUNCTIONAL MAP & REGRESSION TRACKER

Structure per your spec:
**CATEGORY → FUNCTION → Processes**, and adjacent to each function:
- ✅ **Success report** — the observable proof it works. *This line IS the permanent regression check that goes into the acceptance suite.*
- ⚠️ **Breaks / errors / gaps** — known failures + status: `OPEN` / `FIXED` / `GAP`.
- 🔧 **Fix** — remediation (or "known-good").
- 🔒 **0-regression instruction** — tight, paste-ready for Claude Code, batched by function.

**Standing rules** (paste atop every instruction): surgical changes only; re-run the FULL flow in BOTH modes before "done"; no silent failures; prove on the DEPLOYED app with real responses; don't restyle what wasn't asked.

**Key link:** the standing acceptance suite = the sum of every ✅ Success line in this document. Each function's success criterion is one tripwire. New bug found → add its check here before the fix commits.

---

## CATEGORY MAP (the whole system)

1. **Account Management** — account lifecycle, credentials, contacts *(fully populated below)*
2. **Authentication & Session** — signup auth, login, session persistence, recovery
3. **Contacts & Channels** — slots, channel selection, LINE QR pairing, deliverability
4. **Mode & Presentation** — covert (Stillpoint) / overt, present toggle
5. **Trigger & Activation** — arming, trigger gesture/button, mandatory-recipient gate, capture start
6. **Cascade & Notification** — sequential cascade, slot collapse, DO-alarm timing, fail-advance
7. **Coordinator & Response** — claim, access tiers, claim-halts-cascade
8. **Closure & Duress** — closure request, 3-digit pin, duress, one-close-door, force-close
9. **Evidence & Custody** — live feed vs sealed package, hash chain, custody transfer
10. **Check-in ("I'm OK")** — dormant-only reassurance ping, optional location
11. **Dashboard & Authority View** — map, frozen origin, situation latch, controls, locale
12. **Platform & Delivery** — PWA, service worker, safe-area, deploy, D1/R2, backup
13. **Regression & Test Governance** — the suite itself, tags, the floor

---

# CATEGORY 1 · ACCOUNT MANAGEMENT  *(worked example — full depth)*

### FUNCTION: Create account
- **Processes:** generate opaque ID → capture first/last name + nationality → set password (PBKDF2) → create session → land authenticated, settings reachable. No email-verification gate.
- ✅ **Success:** a brand-new user signs up with NO email gate, lands authenticated in one step, and can immediately reach Settings.
- ⚠️ **Breaks / gaps:** `FIXED` — email OTP was a hard gate; SendGrid failure → 502 → no session → every authenticated call downstream died. `GAP` — no email verification at all now (deliberate tradeoff); no account-recovery path if credentials lost.
- 🔧 **Fix:** removed email from the auth critical path (migration 0016, password auth); legacy accounts log in via closure-pin fallback (flagged: temporary bridge — the duress secret must not remain a transmitted password long-term).
- 🔒 **0-reg instruction:** *Known-good. Lock:* add suite check — "new signup completes with no email gate, returns an authenticated session, Settings reachable" — both modes.

### FUNCTION: Edit account
- **Processes:** edit first/last name + nationality → persist → reflect in dashboard + alert payload.
- ✅ **Success:** edits save, persist across reload, and appear correctly in the alert/dashboard (e.g., the user's name, not a hardcoded value).
- ⚠️ **Breaks / gaps:** `FIXED` — "DEVICE WENT DARK" rendered a hardcoded "Her" pronoun instead of account data.
- 🔧 **Fix:** alert/dashboard strings pull from account fields; pronoun/name not hardcoded.
- 🔒 **0-reg instruction:** *Lock:* suite check — "edited name persists across reload AND renders in a triggered alert payload."

### FUNCTION: Add contacts
- **Processes:** choose slot (primary/secondary/tertiary/guardian) → enter contact → choose channel (email / LINE-via-QR / SMS if deliverable) → validate deliverability → persist to the correct slot.
- ✅ **Success:** contact persists to the exact slot chosen (incl. a "support"/guardian contact); channel validated at save; LINE only attaches via QR capture — no typed ID anywhere.
- ⚠️ **Breaks / gaps:** `FIXED` — support contact not persisting to the right slot; `FIXED` — manual LINE handle entry stored a non-deliverable destination; `FIXED` — SMS stub failed silently.
- 🔧 **Fix:** QR-connect captures LINE userId (handles refused at save); `isChannelDeliverable()` rejects non-deliverable channels (400); default channel = email.
- 🔒 **0-reg instruction:** *Lock:* suite check — "contact saves to the chosen slot and persists; LINE cannot be saved without a QR-captured userId; non-deliverable channels are rejected, not silently stored."

### FUNCTION: Remove contacts
- **Processes:** delete contact from slot → contiguous reindex of remaining slots → update UI.
- ✅ **Success:** removal succeeds, remaining slots reindex contiguously (no gaps), UI reflects it, no silent failure.
- ⚠️ **Breaks / gaps:** `FIXED` — CORS was missing the DELETE method → removal failed silently.
- 🔧 **Fix:** added DELETE to CORS; contiguous reindex on delete.
- 🔒 **0-reg instruction:** *Lock:* suite check — "remove a middle contact → remaining slots reindex contiguously → deletion confirmed, never silent."

### FUNCTION: Change password
- **Processes:** authenticate current credential → set new (PBKDF2) → refresh/invalidate session.
- ✅ **Success:** password change works; the old password fails and the new one works on next login.
- ⚠️ **Breaks / gaps:** `GAP` — pin-as-password fallback is a temporary bridge (duress secret should not double as a transmitted password); `GAP` — no password-reset/recovery flow.
- 🔧 **Fix:** *open design item* — separate the closure pin from the login credential; add a recovery path (see Authentication & Session).
- 🔒 **0-reg instruction:** *When built:* suite check — "after password change, old credential rejected, new credential authenticates."

### FUNCTION: Change pin (closure pin)
- **Processes:** Settings edits the single **3-digit on-device closure pin** = sole source of truth for BOTH SAT (safe) detection and duress baseline → explicit save.
- ✅ **Success:** the new pin is the SAT code; altering its last digit signals duress; evaluated on-device, never transmitted; no legacy pin path remains.
- ⚠️ **Breaks / gaps:** `FIXED` — legacy 4-digit server pin and defunct backup code retired (Brief 12). Verify no legacy evaluation path lingers anywhere.
- 🔧 **Fix:** Brief 12 unified to one 3-digit on-device pin as sole source of truth.
- 🔒 **0-reg instruction:** *Lock:* suite check — "Settings pin is the only closure source; correct = SAT, last-digit-altered = duress; pin value never leaves the device (only status transmits)."

### FUNCTION: Delete account
- **Processes:** confirm intent (explicit) → purge account + contacts + sessions → revoke credentials → confirm to user.
- ✅ **Success:** account deletable from Settings; all associated data purged; user cannot log back in afterward.
- ⚠️ **Breaks / gaps:** `FIXED` — delete-account was missing entirely.
- 🔧 **Fix:** added delete-account endpoint + Settings control.
- 🔒 **0-reg instruction:** *Lock:* suite check — "delete account purges contacts + sessions; subsequent login with old credentials fails."

### FUNCTION: Manage guardian slot
- **Processes:** exactly one guardian slot → toggle on/off → **locked during an active event**.
- ✅ **Success:** guardian add and on/off work; the slot cannot be edited while an event is active.
- ⚠️ **Breaks / gaps:** confirm the active-event lock is enforced server-side, not just hidden in UI.
- 🔧 **Fix:** known-good per spec; verify server-side lock.
- 🔒 **0-reg instruction:** *Lock:* suite check — "guardian toggle works when dormant; guardian edits are rejected during an active event."

---

# CATEGORIES 2–13 · SKELETON  *(functions listed — populate on request, one batch each)*

## CATEGORY 2 · Authentication & Session
Functions: signup auth · login (password + legacy-pin fallback) · session persistence · logout · **account recovery (GAP — none today)** · password reset (GAP).

## CATEGORY 3 · Contacts & Channels
Functions: slot model (3 priority + 1 guardian) · channel selection · **LINE QR pairing** · deliverability validation · channel fallback ordering (NotificationRouter priority).

## CATEGORY 4 · Mode & Presentation
Functions: covert facade (Stillpoint) · overt instrument · **present toggle** (right=overt/ON, left=covert/OFF, second confirmation) · reveal gesture (inspection-only, never activation).

## CATEGORY 5 · Trigger & Activation
Functions: arm · trigger (covert gesture / overt button) · **mandatory-recipient gate** (cannot arm with zero filled slots) · capture start (audio + location) · one-active-event enforcement.

## CATEGORY 6 · Cascade & Notification
Functions: sequential cascade (priority order) · **slot collapse** (empty slots don't consume a window) · **DO-alarm timing** (0/10/20/30/40, emergency ≤40) · fail-advance (failed/missing step never halts chain) · per-channel delivery + audit.

## CATEGORY 7 · Coordinator & Response
Functions: **coordinator claim** (explicit POST only, one claim, sticky/idempotent) · access tiers (coordinator = full; others = location-only) · **claim halts cascade** · coordinator never enters the pin.

## CATEGORY 8 · Closure & Duress
Functions: user closure request (3-digit, explicit submit) · on-device eval (never transmitted) · **duress** (last-digit-altered, screen-identical) · typo handling (3 tries → lockout + notify) · **one-close-door** (user can't self-close; coordinator secures; refresh ≠ close) · operator force-close (audited).
> *Note: this category currently has the active P0 + permanent-test work in flight. Its ✅ checks are the highest-priority suite entries.*

## CATEGORY 9 · Evidence & Custody
Functions: live feed (ephemeral token ~6h) · sealed evidence package (SHA-256 hash chain, write-once) · **4-step chain-of-custody** (identity gate → authorization → assemble/seal → recorded transfer to verified recipient) · tamper-evident verification.

## CATEGORY 10 · Check-in ("I'm OK")
Functions: dormant-only reassurance ping · disabled during active event · optional per-tap location · **clickable location link** (map) · no session created.

## CATEGORY 11 · Dashboard & Authority View
Functions: render order (map → frozen origin t=0 → latched situation → camera/audio → transcript → controls) · frozen origin snapshot · situation latch · emergency-number locale (JP 110/119) · authority CAD/coordinates overlay.

## CATEGORY 12 · Platform & Delivery
Functions: PWA install · **service worker self-update** (skipWaiting + clientsClaim) · **safe-area insets** (gear clear of status bar, standalone only) · deploy (wrangler → Workers + Pages) · D1 / R2 · git backup + tags.

## CATEGORY 13 · Regression & Test Governance
Functions: the standing acceptance suite (sum of all ✅ checks) · run-on-every-commit against the deployed app · `known-good-<date>` tag + push · the suite's own rule (every new bug adds a check before its fix commits).

---

## HOW TO DRIVE THIS
1. Pick a category → I populate every function to the Account-Management depth (processes / success / breaks / fix / 0-reg instruction).
2. Each ✅ Success line is dropped into the acceptance suite as a permanent check.
3. Open breaks become batched fix instructions, by function, paste-ready for Claude Code.
4. When a category is green and its checks are in the suite → tag `known-good-<date>`, push. That tag is the floor.
