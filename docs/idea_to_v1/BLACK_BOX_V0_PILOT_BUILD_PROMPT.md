# BLACK BOX — v0 Pilot Build Prompt

**Version:** 1.0
**Purpose:** The single document you paste into Claude Code to start the real v0 build. Consolidates everything we've decided through specification and prototype testing. References the existing runbook for technical phasing; adds the design decisions that came out of the design conversation.

**Pilot users:** Royce (Okinawa, Japan) and Ikumi (his wife). Two-person pilot. They use LINE.

---

## How to use this document

1. Complete the pre-flight checklist in `BUILD_INSTRUCTIONS.md` section 3 first. Accounts, tools, domain decision. Do not skip.
2. Open a terminal in your project directory.
3. Run `claude` (Claude Code CLI).
4. Paste the kickoff prompt at the bottom of this document.
5. Work through the phases. Verify each before moving to the next.

---

## What v0 includes (scope locked)

After the design conversation, this is the final v0 scope. Anything not in this list is v0.5 or later.

**Pilot v0 includes:**
- PWA installs to phone, single-user account, no signup friction (account auto-generated)
- Meditation facade as default view ("Stillpoint" branding — calming breathing animation)
- Hidden gesture: 5-second press on breathing circle reveals real dashboard **for inspection only** — this is NOT an activation trigger
- Dashboard auto-returns to meditation view after 60 seconds of inactivity
- **Covert activation:** activation happens entirely through paths invisible to any observer
  - Primary: voice phrase via Siri/Google Assistant ("Hey Siri, [user's phrase]") — works from any phone state
  - Secondary: covert physical button sequence (specific quick presses of phone hardware buttons, configurable) — works while app is backgrounded
  - Both can fire simultaneously without conflict
- **No on-device confirmation of activation.** No toast. No haptic. No sound. No screen change. No visible UI indicator. The phone behaves identically before and after activation as far as any observer can see.
- **Acknowledgment is external only:** the contact's phone call or text message to the user is the confirmation that the system worked. There is no in-app way to verify activation succeeded.
- Recording: audio + front camera (Capacitor wrapper on iOS for native camera access)
- Real-time GPS streaming
- Local transcription via Web Speech API (best-effort; degrades gracefully)
- Local keyword classifier (English + Japanese)
- BYOK AI for richer summary (optional — local floor works without it)
- Cloudflare Worker + R2 + D1 backend (minimum viable)
- Account model: only users have accounts. Contacts are notification endpoints only — no app install required for the contact, no account for the contact.
- One designated contact per user (Ikumi for Royce; Royce for Ikumi)
- LINE bot for notifications (primary channel — both pilot users have LINE)
- Telegram bot as backup notification channel
- The contact's "interface" is the LINE/Telegram message itself, optionally with a magic-link read-only web view (no login required) showing live audio + location
- Pin-based closure: user enters 4-digit pin via dashboard, contact approves via LINE
- Duress pin variant: same first 3 digits, wrong 4th digit signals duress (alert continues)
- History view (accessible only via dashboard inspection gesture)
- Settings: name, contact, pin, voice phrase, covert button sequence, recording mode, AI provider
- Capacitor iOS wrapper with App Shortcuts (Siri voice trigger registered) and hardware key listener
- AGPL-3.0 license, public GitHub repo at v0 launch

**Pilot v0 does NOT yet include:**
- **Shake activation** (excluded — accidental triggers, observable to aggressor)
- **Drop activation** (excluded — accidental triggers, observable)
- **Visible activation button on screen** (excluded — observable, defeats covert principle)
- **5-second press as activation trigger** (excluded — observable interaction with phone; the gesture is kept for *dashboard inspection*, not activation)
- **Contact-side account or app install** (excluded — contacts are notification endpoints, not users)
- **Contact-side authenticated dashboard** (excluded — contacts get message-only experience, optionally with magic-link read-only view)
- Multi-contact cascade with escalation timing (single contact for now)
- Guardian tier with reverse activation (post-MVP)
- Authority access portal (post-MVP)
- Tamper-proof cryptographic chain (basic IndexedDB integrity only for v0)
- Background sound identification beyond keyword classifier
- Multi-user dashboards (you only have one pair)
- 360° camera or hardware-tier features (no v1 hardware yet)
- Active deterrent features (no piezo, no strobe — v2 hardware)
- Companion mode, scheduled monitoring, periodic check-in (v0.5)
- Crowd response network (v1+)
- Voice biometric authentication (v0.5)
- iCloud/Drive storage piggyback (v0.5)
- Find My network passive relay (requires MFi approval, year 1+)
- Trusted location auto-disarm (v0.5)
- Trusted person system (v0.5)

---

## The design decisions that came out of prototyping

These shape what gets built across multiple phases. Claude Code needs to internalize all of these because they cut across W1–W9.

### 1. Covert activation (cuts across W2, W7, W8, W9)

**The activation principle, stated plainly:**

> The user activates. The phone shows nothing. The system runs. The contact is notified. The contact reaches out externally. That is the entire trigger-to-acknowledgment loop.

Activation must be:
- **Covert** — invisible to any observer of the phone
- **Silent** — no sound, no visible state change
- **Background** — works regardless of which app is foreground, whether phone is locked, whether screen is off
- **Reliable** — the user must trust that speaking the phrase or executing the button sequence will work

When activation fires:
- **No toast notification** anywhere in the UI
- **No sound**
- **No screen change** — the meditation view (or whatever app is foreground) continues unchanged
- **No status bar indicator from our app**
- **The OS-level recording indicator** (red dot in iOS status bar, mic icon in Android) WILL appear because the operating system requires it. We do not attempt to suppress it. Onboarding trains the user to expect this and to have plausible cover (the meditation facade uses mic for "breath sensing").

**The one minimal on-device acknowledgment: two long haptic pulses (network-confirmed only).**

Once the backend confirms that the contact's notification has been successfully delivered (LINE message sent to the bot API and accepted, or Telegram equivalent), the phone vibrates with a specific pattern: **800ms vibrate, 200ms pause, 800ms vibrate** (two distinct long pulses).

This haptic fires ONLY on confirmed network delivery, not on local activation. The user feels these pulses only when help has actually been reached — when there is something to be confirmed about. If the notification fails to deliver (no signal, contact unpaired, etc.), no haptic fires.

Timing: typically 2–5 seconds after activation, depending on network. If no confirmation arrives within 10 seconds, the system retries on additional channels (Telegram, email, web push) and the haptic fires on the first success.

Implementation:
- Web Vibration API: `navigator.vibrate([800, 200, 800])`
- Works natively on Android Chrome
- Requires Capacitor wrapper on iOS (Safari PWA blocks Vibration API) — fully functional from W8 onward
- During W2-W7 development, Android testing has the haptic working; iOS testing waits for W8
- User can disable haptic in settings (default: ON). When disabled, the user has no on-device confirmation — they rely entirely on the contact's external call/text.

**The user knows activation worked when they feel the two pulses, OR when the contact phones or texts them.** The pulses are local confirmation that the network leg succeeded; the contact's call is human confirmation that the alert was seen and acted on.

**Trigger mechanisms (implemented in W8 — Capacitor wrapper):**

| Mechanism | Status | Notes |
|---|---|---|
| 5-second press on the Stillpoint breathing circle | Primary | The user holding the circle as part of "meditation" — covert, deniable as part of practice. Plausible visible action. |
| Voice phrase via Siri/Google Assistant | Primary | "Hey Siri, [phrase]" — works from any state. Requires user to have Siri/Google Assistant enabled. Onboarding verifies this. |
| Covert hardware button sequence | Secondary | Specific quick-press pattern on hardware buttons (volume/power), configurable. Works while app is foregrounded or recently backgrounded. Platform-specific defaults to avoid conflicts with OS bindings (e.g., iOS Emergency SOS). |

All three can fire simultaneously without conflict. The system deduplicates within 60 seconds.

**Explicitly NOT activation triggers:**
- Shake gesture (accidental triggers, observable to aggressor)
- Drop detection (accidental triggers)
- Any visible button on screen labeled "activate" or similar

**For W1 specifically:** The 5-second press on the breathing circle is wired up with progress ring visualization but fires nothing visible on completion. Log a `console.debug` internally on completion so we can verify the trigger fires during development. The actual recording invocation and haptic feedback are W2 scope.

### 2. Stillpoint is the entire visible interface (cuts across W1, W2, W9)

There is no dashboard. There is no second screen. There is no armed view. There is no BLACK BOX wordmark anywhere the user can see during normal use.

The Stillpoint meditation app is the entire visible surface. Always. From install to use to closure.

The user configures the system once during onboarding (W9). After that, the only visible app is Stillpoint. The 5-second press on the breathing circle is an activation trigger. Voice and button-sequence are alternative triggers. The closure flow is initiated through a "session closeout" interaction within Stillpoint itself — to an observer, the user is ending their meditation session. The pin entry that requests closure looks like a meditation app's "session lock code" or similar innocuous prompt.

Anything that would normally live in a settings screen, history view, or admin panel either:
- Lives only in onboarding (set once, not edited after), OR
- Lives disguised inside Stillpoint's existing surface (the gear icon opens what looks like meditation preferences but actually configures BLACK BOX), OR
- Does not exist at all (e.g., history of activations is not shown to the user, because it would either be missing if no activations occurred, or it would be a record the user shouldn't be carrying around)

### 3. The meditation facade (cuts across W1, W2, W9)

The "Stillpoint" meditation app is the default view. Specifications:

- Calming gradient background: deep navy/purple, slowly shifting hue over 30s cycles
- Three concentric breathing circles with offset breathing animation
- "Breathe" or similar serif label fading in/out with breath rhythm
- Session timer counting up (real meditation app would track this; serves as plausible activity)
- Soft typography (Cormorant Garamond serif for meditation; IBM Plex for BLACK BOX)
- Settings access only via dashboard reveal
- No mention of "BLACK BOX," "safety," "emergency" anywhere on the meditation surface

The reveal gesture: press and hold the central breathing circle for 5 seconds. A progress ring slowly fills as user holds. Release before 5 seconds = no reveal. Hold past 5 seconds = smooth transition to BLACK BOX dashboard.

After 60 seconds of inactivity in the dashboard, auto-return to meditation view. Recording continues silently if active.

Production hold duration: 5 seconds (testable; can be shortened in settings for users who confirm they understand the tradeoff).

### 4. Voice activation via Hey Siri / Hey Google (cuts across W8)

We do NOT build always-on listening into BLACK BOX. The phone's existing voice assistant does the listening for free.

iOS (Capacitor wrapper required):
- Register an App Shortcut with iOS via the App Intents API
- User configures their trigger phrase in BLACK BOX settings (e.g., "Treeline")
- The full invocation becomes "Hey Siri, treeline"
- Siri launches BLACK BOX directly into activation mode
- Works from locked screen, from pocket, from any state where Siri is enabled

Android:
- Register an App Action via the Google Assistant App Actions catalog
- Same flow: "Hey Google, treeline" → BLACK BOX activates

Onboarding includes verifying the user has "Hey Siri" enabled in their system settings; if not, link out to the appropriate iOS Settings deep link to enable it.

### 5. Closure protocol (cuts across W6, W7, W9)

The user CANNOT cancel the alert from their own device. Activation is committal. Only the contact can approve closure.

Flow:
1. User reveals dashboard (5-second press on meditation circle)
2. User taps "REQUEST CLOSURE" button (only visible in dashboard during active state)
3. Pin entry overlay appears (4 digit pad)
4. User enters their 4-digit pin

System validates:
- **Correct pin:** Contact receives LINE message: "[User] is requesting closure. Pin sat. Listen to last 30s, view location. Approve or hold." Contact has 3 buttons: Approve / Hold / Override. Approve closes the alert. Hold keeps it open. Override escalates.
- **Duress pin variant** (first 3 digits correct, 4th digit wrong): Contact receives identical-looking closure request, BUT with a flag visible only to the contact: "DURESS DETECTED — pin entered with last digit altered. Threat may be ongoing. Do not assume safe." Recording continues regardless of contact's response.
- **Wrong pin** (other variations): Silent reset. Pin display clears. No error toast. User can try again.

On the user's side, the pin overlay closes silently on submission. No "pin sent" confirmation. The user knows it worked if the contact subsequently calls/texts approval. The acknowledgment is the call, not a toast.

### 6. The contact's role and protocol (cuts across W6, W9)

Onboarding includes training for the contact:

- When you receive a BLACK BOX alert, your first action is to **call the user**, even if you don't know what's happening
- Use a scripted innocuous phrase: "Hey, just calling about [dinner / mom / the package / weekend plans]"
- This phone call serves as the user's confirmation that the system worked
- Then open the live dashboard via the LINE link
- Listen, observe, share to authorities if needed
- If the user requests closure, listen to the last 30s of audio + observe location before approving

Contact's tools in LINE (via bot quick replies):
- "I am responding" (acknowledgment, propagated to user's hidden dashboard if they check)
- "Approve closure" (when closure request arrives)
- "Hold closure — need to verify"
- "Override — escalate"
- "Call 110" (Japan emergency number — quick dial)

### 7. Account and pairing model (cuts across W5, W6)

No traditional signup. On first launch, PWA generates a UUID locally. This UUID is the user's account identifier on the Worker backend. No email, no password, no phone number required (though phone number can be added optionally for SMS fallback).

Pairing:
- Royce opens BLACK BOX, goes to Settings → Add Contact
- App generates a 6-character pairing code (e.g., "K7M-3PQ")
- Royce shares this code with Ikumi via any channel (text it to her, show her the screen, say it out loud)
- Ikumi opens her BLACK BOX, goes to Settings → Accept Pairing
- Enters the code
- Backend records: Royce's UUID ↔ Ikumi's UUID, mutual designated contacts
- From now on, when Royce activates, Ikumi gets the LINE notification
- Same in reverse

Both users see each other in their dashboard's "Designated Contact" field.

### 8. Notification stack (cuts across W6)

Notifications fire in parallel via every channel available:

1. **LINE bot push** (primary for both users — they use LINE)
2. **Telegram bot push** (backup, if user has paired Telegram)
3. **Web Push** (PWA-native, free, works on Android; limited on iOS)
4. **Email** (via SMTP, fallback for low-priority)

LINE bot uses Flex Messages for the activation alert: location pin, 3-second audio preview, dashboard link, "I am responding" quick reply, "Approve closure" / "Hold" / "Override" quick replies (during closure request).

If any channel succeeds, the others are marked supplementary. The first to acknowledge becomes the coordinator (relevant when there are eventually multiple contacts, but for v0 pilot there's only one).

---

## Build sequence

Follow the runbook (`BUILD_INSTRUCTIONS.md`) for technical phases. Modify per the design decisions above. Here's the sequence:

| Phase | What | Add from this doc |
|---|---|---|
| W1 | PWA shell deployable | Meditation facade as default home view, AGPL-3.0 license file |
| W2 | Capture + IndexedDB | Silent activation (no toasts), no video preview thumbnail, dashboard auto-return to meditation after 60s |
| W3 | BYOK + AI router | Optional, local floor must work without AI |
| W4 | Local transcription + classifier | English + Japanese keyword libraries |
| W5 | Worker + R2 + D1 | Account UUID model, pairing code generation, account-pair relationship table |
| W6 | LINE + Telegram bots | LINE Flex Messages with quick replies, closure approval flow with duress flag, pairing code redemption flow |
| W7 | Live dashboard with share | Dashboard visual stability (no red active state), history list as the only active-state indicator |
| W8 | Capacitor iOS wrapper + BLE + Voice | Register App Shortcuts for Siri trigger phrase, register App Actions for Google Assistant, BLE pairing scaffolding (for future v0 button accessory) |
| W9 | Polish + beta | Onboarding flow including contact pairing, voice assistant verification step, training screen for the contact's protocol |

---

## The kickoff prompt for Claude Code

Once pre-flight is done, open `claude` in your project directory and paste this:

---

```
You are building BLACK BOX v0 — a personal safety PWA + iOS native app. This is the pilot version for two users (Royce and his wife Ikumi). It is a real product that protects real people. Treat it accordingly.

Read these documents in full before writing any code. Confirm by summarizing each back to me before starting:

1. BLACK_BOX_PRINCIPLE.md — the foundation, non-negotiable
2. BLACK_BOX_V0_PILOT_BUILD_PROMPT.md — this document, scope and design decisions
3. BUILD_INSTRUCTIONS.md — the technical runbook (phases W1–W9)
4. BLACK_BOX_LITE_SPEC.md — product positioning
5. BLACKBOX_SOFTWARE_SPEC.md — tech stack and architecture
6. PWA_INTERFACE_SPEC.md — design tokens and visual specs
7. BLACK_BOX_LICENSING_AND_PROTECTION.md — AGPL-3.0 + foundation strategy
8. blackbox_v0_pilot.html — visual reference for the meditation facade and hidden-gesture pattern (use this design language for the PWA's actual implementation)

After confirming you've read these, implement Phase W1 — Foundation. Do not start W2 in this session.

W1 deliverables:
- pnpm monorepo with workspaces: apps/pwa, workers/api, packages/shared
- Vite 5 + React 18 + TypeScript (strict) + Tailwind 3 + shadcn/ui in apps/pwa
- vite-plugin-pwa for service worker
- Web manifest named "Stillpoint" with icons (192, 512, maskable) — facade-themed, not safety-themed
- Routes (minimal): / (Stillpoint meditation) and /settings (empty placeholder for future)
- There is NO /dashboard route, NO /history route, NO /onboarding route. Stillpoint is the entire visible app.
- Stillpoint home (/):
  - Hue-drifting navy → purple gradient background (30s cycle)
  - Three concentric breathing circles with offset breath animation
  - "Stillpoint" wordmark + "Breathe" label in Cormorant Garamond serif
  - Session timer counting up
  - Press-and-hold gesture on the central breathing circle (5s prod / configurable via VITE_REVEAL_HOLD_MS for dev)
  - Progress ring visualizes the hold
  - On completion of the hold: log a console.debug "trigger fired" and produce NO visible output. The screen does not change. There is no navigation. There is no toast. The user sees nothing different. The trigger logic is wired for W2 to attach recording to.
  - No BLACK BOX wordmark, no safety language, no emergency language anywhere on this surface
- /settings: empty route placeholder. Will be built in a later phase. Do not implement any UI here in W1.
- Tailwind config extends design tokens from PWA_INTERFACE_SPEC §2
- IBM Plex font family loaded via @fontsource (for future use in onboarding)
- Cormorant Garamond loaded for Stillpoint
- Hono framework Worker scaffold in workers/api/ with wrangler.toml and a /health endpoint. Not deployed in W1.
- packages/shared/ with Zod schemas placeholder
- LICENSE file: AGPL-3.0 (download from gnu.org, do not generate)
- README.md with setup instructions, principle citation, contributing guidelines
- .gitignore appropriate for Node.js + pnpm + Vite on Windows

Build per the principle: single sale, humanized, people-first. No analytics. No telemetry. No tracking. No retention loops. No engagement metrics.

When complete, deploy the PWA to Cloudflare Pages using wrangler. Output the live URL.

After deployment, stop and ask me to verify W1 acceptance criteria before doing anything else.

If any requirement above is ambiguous, ask clarifying questions before starting. Do not assume.
```

---

## Acceptance criteria for the full v0 pilot

Once W1 through W9 are all complete and Capacitor iOS build is in TestFlight, you and Ikumi should be able to do this end-to-end test successfully:

1. Both phones have BLACK BOX installed (you both via TestFlight)
2. Both have completed onboarding, including contact pairing (you paired with Ikumi, she paired with you)
3. Both have configured voice trigger phrases ("Hey Siri, treeline" or whatever you chose)
4. **Test A:** Royce activates via manual button while Ikumi watches. Royce's screen shows nothing changing. Within 60 seconds, Ikumi's LINE shows the alert with Royce's location, dashboard link, audio preview.
5. **Test B:** Royce activates from another room via "Hey Siri, treeline" while Ikumi watches her phone. She receives the LINE alert within 30 seconds. She calls Royce ("hey, just calling about dinner"). Royce hears the call — confirms the system worked.
6. **Test C:** Royce opens the dashboard via 5-second press, requests closure with correct pin. Ikumi receives "Royce is requesting closure" in LINE with approve/hold/override buttons. Approves. Royce's recording stops silently. Royce sees no toast — but knows it worked because Ikumi called him to confirm.
7. **Test D:** Royce activates, then enters duress pin (correct first 3, wrong 4th). Ikumi sees "DURESS DETECTED" in her LINE notification. She does NOT approve closure. Recording continues. She calls 110 (in real scenario) or simulates the response.

When all four tests pass, v0 pilot is ready. You and Ikumi pilot it for 2–4 weeks with daily use (practice activations, real-world wear-testing, see how it feels). Notes go into a shared doc. After pilot, you'll know what v0.5 should be.

---

## What to do after v0 pilot completes successfully

1. Push the AGPL-3.0 licensed code to public GitHub
2. Write the public launch announcement explaining the principle and the licensing
3. File the provisional patent (within 30 days of any public posting, per `BLACK_BOX_LICENSING_AND_PROTECTION.md`)
4. Begin v0.5: incorporate the lessons from pilot — what felt wrong, what was missing, what was unnecessary
5. Begin v1 hardware planning (Sentinel cube, per the hardware roadmap)

---

**End of v0 pilot build prompt.**

**Final reminder:** Pre-flight first. Read all docs once. Then start Claude Code with the kickoff prompt. Verify each phase before moving on. Patience and rigor matter more than speed.

Build something good.
