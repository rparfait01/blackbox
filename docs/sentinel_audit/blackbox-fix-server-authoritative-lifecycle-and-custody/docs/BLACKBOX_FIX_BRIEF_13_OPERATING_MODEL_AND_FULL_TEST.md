# BLACK BOX — Brief 13: Operating Model + Full Functions Test

Purpose: one authoritative description of how every page, account, access level, and state is
*supposed* to work, followed by an exhaustive function-by-function test. Claude Code runs the test
methodically — not one bug at a time. **Fix on fail, then re-run the ENTIRE matrix (regression)
before moving on.** This is how we stop fixing one thing and breaking another.

Supersedes/absorbs Brief 12 (its fixes appear here as test items).

### Two hard rules for the agent, before anything else
1. **Do not rebuild the contact dashboard.** The live contact/coordinator dashboard is the part
   that has been working. Verify it against the spec; do not refactor or "improve" it. Touch only
   the specific defects listed.
2. **The build must self-update — the user cannot hard reset on their phone.** Fix the service
   worker so a new build takes over automatically: `skipWaiting()` + `clients.claim()`, a version
   bump on each deploy, and an in-app "update available — reload" path. Every test below starts from
   a build the agent has confirmed is the latest actually being served on device.

---

# PART A — OPERATING MODEL (how it is supposed to work)

## A1. Roles
- **User** — owns the device/account. Activates, checks in, requests closure with the pin.
- **Contact** — up to three, priority-ordered (1 → 2 → 3). Notified on alert; can claim coordinator.
- **Guardian** — exactly one. Failsafe and coordinator of last resort. User-toggleable on/off.

## A2. Account lifecycle
1. **Signup** creates an account (opaque ID) with identity: first name, last name, nationality.
2. **Closure pin** (3-digit) must be set before the user can arm — see A7. If missing, the app
   blocks to pin setup; it never lets a user reach an armable state with no way to close.
3. **Add contacts / guardian** (A5).
4. **Ready** — dormant/armed.
5. **Login / logout** — logout is in Settings. A logged-out user can log back in with their
   credentials and land on their existing account.
6. **Delete account** — in Settings, behind a confirmation. Wipes the account and returns to signup.

## A3. Pages & access (USER side — `blackbox-pwa.pages.dev`)
- **Signup**, **Login**, **Closure-pin setup**
- **Home / instrument** — one of two presentations set by the Present toggle (A4):
  - Present OFF → covert facade (Stillpoint)
  - Present ON → overt instrument ("BLACK BOX · ARMED · LISTENING · TAP TO ACTIVATE")
- **Settings** — reachable ONLY when dormant (no active event). Contains: identity, Present toggle,
  closure pin, contacts (add/edit/remove/reorder), guardian (add + on/off), check-in recipients,
  emergency slot, **logout**, **delete account**.
- **Active-event screen** — after activation. Capture running; settings and check-in disabled;
  Request-closure available.
- **Request-closure** → pin pad → **Awaiting-confirmation** screen.
- **Check-in ("I'm OK")** — dormant only.

## A4. The "Present" toggle (covert/overt)
- Settings shows a toggle titled **"Present"** — deliberately ambiguous, no safety-revealing
  subtext. **Right = ON, left = OFF.**
- Changing it requires a **second confirmation** before it takes effect.
- ON = overt instrument display. OFF = covert facade. Underlying engine is identical either way.

## A5. Contacts & guardian
- **Add** a contact → appended at the next free priority slot (max 3).
- **Edit** a contact's details/channel.
- **Remove** a contact → **must always succeed when dormant.** On removal, remaining contacts
  **reindex/shift up** to close the gap: if contact 2 is removed, contact 3 becomes contact 2.
  Priority order stays contiguous (1,2,3 — never 1,3).
- **Reorder** — user can change priority.
- **Guardian** — single slot, separate from contacts; add/replace; on/off toggle.
- **Locked during an active event** — contacts and guardian (and the guardian toggle) cannot be
  changed mid-event (same lock as the closure flow). Editable again once secured.

## A6. State machine
`DORMANT (armed·listening)` → `ACTIVE` → `STANDDOWN-REQUESTED` → `SECURED/CLOSED`
- **DORMANT:** settings ON, check-in ON, activate available.
- **ACTIVE:** capture + cascade running; **settings OFF, check-in OFF**; Request-closure available.
- **STANDDOWN-REQUESTED:** user submitted pin; sees awaiting-confirmation (identical under SAT and
  duress); user CANNOT self-close.
- **SECURED:** only the coordinator secures (server-authoritative); closure status report generated.
  Refreshing the page is not a close.

## A7. Closure pin & duress
- 3-digit, set in Settings. Evaluated **on-device; never transmitted** — only the resulting status
  is sent. Explicit Submit (no auto-submit).
- Correct → status SAT. Last digit altered (first two correct, wrong last) → status UNSAT = DURESS.
  Other wrong → typo: retry, 3 attempts, then brief lockout + notify coordinator.
- **The coordinator never enters or sees the pin** — only sat/unsat. (Remove any "enter user lock
  code" prompt on the dashboard.)

## A8. Check-in ("I'm OK")
- Dormant only. One tap sends "[User] checked in — I'm OK" + timestamp to chosen recipients
  (default guardian). No location unless opted in per tap. No capture, no session, no coordinator.

## A9. Cascade & coordinator
- On activation, contacts are notified **sequentially in priority order, ~15s apart** (primary T+0,
  secondary T+15s, tertiary T+30s, guardian T+45s if enabled); emergency-services fallback after
  the configured window if no one claims. Intervals configurable per account.
- Recipients resolved fresh each dispatch — a newly added contact is always included.
- **Coordinator is claimed once, on a deliberate press, never passively on load.** Responding =
  claiming. There must be exactly ONE ask — not one in LINE and another in the dashboard.
- Coordinator = full access (audio, location, share link). Everyone else = location-only with
  "another responder is coordinating." Cascade halts once claimed.

## A10. Dashboard (contact / coordinator / authority) — PROTECT, don't rebuild
- Layout order: map → frozen origin (t=0) → situation (latched facts) → camera (or audio-only
  notice) → transcript → audio-live → controls.
- Controls: I AM RESPONDING (single deliberate claim), SHARE WITH AUTHORITIES (coordinator only),
  CALL EMERGENCY (locale-correct number), Secure flow (coordinator confirms; PIN shown sat/unsat;
  two-step confirm; duress shows threat-ongoing).

## A11. Access matrix

| Control            | DORMANT | ACTIVE |
|--------------------|:-------:|:------:|
| Settings (gear)    |   ON    |  OFF   |
| Check-in (I'm OK)  |   ON    |  OFF   |
| Activate           |   ON    |   —    |
| Request closure    |   —     |  ON    |
| Edit contacts/guardian | ON  |  OFF   |

---

# PART B — FULL FUNCTIONS TEST

**Legend:** `[A]` agent tests fully, no live alert needed · `[L]` needs Royce's live alert ·
`[A→L]` agent verifies wiring/logic, Royce confirms end-to-end.

**Discipline:** run all → log pass/fail per item → fix every fail → **re-run the whole matrix** →
repeat until every `[A]` and `[A→L]`-wiring item is green. Only then does Royce run the `[L]` items.

## B1. Build freshness `[A]`
- New deploy takes over without a manual hard reset (SW skipWaiting/clients.claim + version bump).
- App shows/handles an "update available" reload. Confirm the device is on the latest build.

## B2. Signup / account creation `[A]` — P0
- New user creates an account on mobile Safari AND installed PWA, first try.
- Check cross-origin POST: API answers the OPTIONS preflight and returns the right
  Access-Control-Allow-Origin for the PWA origin (a failed preflight = silent signup failure).
- Required fields (first, last, nationality) validate inline; missing fields say what's missing.
- Every failure surfaces a plain message; nothing fails silently; submit disables + shows progress.
- On success, routes to closure-pin setup.

## B3. Login / logout `[A]`
- Logout exists in Settings and returns to the login screen.
- Log back in → lands on the same account with contacts/settings intact.
- Wrong credentials show a clear error.

## B4. Closure-pin setup + deadlock guard `[A]`
- User cannot reach an armable state with no pin set — app blocks to pin setup.
- Pin sets and persists across logout/login and app relaunch.
- "Set up your closure pin first" never appears as a dead end with no way to get there.

## B5. Settings access & gating `[A]`
- Settings gear opens when DORMANT (this is currently broken — fix).
- Settings is disabled/blocked when ACTIVE.

## B6. Present toggle + confirmation `[A]`
- Toggle titled "Present," right = ON, left = OFF.
- Changing it triggers a required second confirmation before it applies.
- ON renders overt instrument; OFF renders covert facade; both arm/activate identically.

## B7. Contacts CRUD + reindex `[A]` — currently failing
- Add contact → fills next priority slot.
- Edit contact → persists.
- **Remove contact succeeds when dormant** (the "cannot remove" error must be gone).
- **Reindex on remove:** delete contact 2 → contact 3 becomes contact 2; order stays contiguous.
- Reorder priority works and persists.
- All contact edits blocked when ACTIVE.

## B8. Guardian `[A]`
- Add/replace guardian; on/off toggle persists.
- Guardian edits blocked when ACTIVE.

## B9. Check-in `[A]` wiring / `[L]` delivery
- Check-in works DORMANT; disabled ACTIVE.
- "Include my location this time" sends location only when ticked, for that tap only.
- Sends to chosen recipients (default guardian); creates no session/coordinator. `[L]` confirm the
  recipient actually receives "I'm OK" + time.

## B10. Activation / state transitions `[A→L]`
- Activate moves DORMANT → ACTIVE; settings + check-in go OFF; Request-closure appears.
- `[L]` confirm capture (audio + location) actually starts.

## B11. Cascade timing & delivery `[L]`
- Contacts fire sequentially ~15s apart in priority order; guardian per A9; emergency fallback if
  unclaimed. Newly added contact included. No duplicate dispatch (two identical LINE cards bug).

## B12. Coordinator claim `[A→L]`
- Claim is a single deliberate press; no double-ask across LINE and dashboard.
- Claimer = full access; others = location-only + "another responder is coordinating."
- Cascade halts on claim. `[L]` confirm across two real recipients on different channels.

## B13. Request-closure → awaiting → secure `[A→L]`
- Pin pad requires explicit Submit; user then sees awaiting-confirmation (cannot self-close).
- Coordinator secures via two-step confirm; **no pin entry on the dashboard.**
- Secured session generates the closure status report. `[L]` confirm end-to-end.

## B14. Duress path `[A→L]`
- `[A]` on-device: last-digit-altered → UNSAT/duress; awaiting screen identical to SAT.
- `[L]` dashboard shows threat-ongoing/duress unmistakably; not mistakable for safe closure.

## B15. Dashboard rendering `[A]` — verify only, don't rebuild
- Map, frozen origin, latched situation/facts, camera-or-audio-only notice, transcript, audio-live
  all render in the A10 order.

## B16. Display correctness `[A]`
- Recording timer shows true elapsed (not runaway like 2188:56).
- Origin snapshot latches and resolves (not stuck on "Capturing initial-contact snapshot…").
- DTG matches real activation time/locale.
- Emergency number locale-correct and consistent everywhere (Japan: 110 police / 119 ambulance) —
  no 110-vs-112 mismatch.

## B17. Delete account `[A]`
- Delete option in Settings, behind confirmation; wipes account; returns to signup; deleted account
  can't log back in.

## B18. Error messaging `[A]` — cross-cutting
- No action anywhere fails silently. Every button/pad/data-change either succeeds visibly or shows a
  plain-language reason. Specifically re-check: signup, contact remove, pin submit, login.

---

## Acceptance gate
- All `[A]` items green and all `[A→L]` wiring verified, with a clean regression pass, BEFORE Royce
  runs the live test.
- Royce's live test then covers only the `[L]` end-to-end path: activation → cascade → coordinator
  claim → closure/duress → secure, plus check-in and notification delivery on real channels (LINE /
  email).
