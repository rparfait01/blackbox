# BLACK BOX — Build Runbook

**Version:** 1.1
**Purpose:** Single operational reference from "empty directory" to "PWA in beta testers' hands."
**Audience:** You + Claude Code, working through phases sequentially.
**Foundation:** Every phase below is built per the principle in `BLACK_BOX_PRINCIPLE.md`. Read that file first.

---

## 0. The Principle (read this before anything else)

This product is built on a non-negotiable foundation:

> **Single sale. Humanized thought. Human benefit. Not profit-driven per se. Not exploitative. People first.**

The full statement is in `BLACK_BOX_PRINCIPLE.md`. The short version that every engineering decision references:

- **Single sale.** Pay once. Own forever. No subscriptions. Ever.
- **Humanized thought.** Build for a scared person at 2 a.m., not for a conversion funnel.
- **Human benefit.** Outcomes for people, not metrics for dashboards.
- **Not profit-driven.** Revenue serves the protection. The protection is the goal.
- **Not exploitative.** No advertising. No data sales. No fear-based marketing. No engagement loops.
- **People first.** When convenience and wellbeing trade off, wellbeing wins. Documented as a rule.

**Every Claude Code phase prompt below ends with the principle reminder.** It is not a slogan. It is a constraint that shapes the architecture.

If during the build a decision arises that conflicts with the principle, the decision loses. The principle document wins.

---

## 1. What you are building and how long it takes

You are building **BLACK BOX Lite** — a free Progressive Web App that turns the user's phone into a personal safety recorder. BYOK AI architecture, no subscription, ships on Cloudflare's free tier. The software is free forever. Hardware is the eventual business model — single sale, no recurring fees.

| Milestone | Realistic timeline (solo, evenings + weekends) | What's live |
|---|---|---|
| Pre-flight done | 1 day | Accounts created, tools installed, repo ready |
| W1–W2 complete | Weekend 1 | PWA installs to phone, can capture audio/video locally |
| W3–W4 complete | Weekend 2 | BYOK works, AI classifies, local fallback works |
| W5–W6 complete | Weekend 3 | Cloud upload, LINE/Telegram bot delivers alerts |
| W7 complete | Weekend 4 | Live dashboard with share button |
| W8 complete | Weekend 5–6 | Capacitor iOS app in TestFlight, BLE button paired |
| W9 complete | Weekend 7 | Beta-ready, onboarding polished |
| Beta launch | Week 8 | 5–10 testers using it daily |

**Total: roughly 7 focused weekends to launchable MVP.** Faster with a co-builder or full-time focus.

---

## 2. Document map

You'll reference these documents throughout. Keep them within reach.

| File | When to read it |
|---|---|
| **`BLACK_BOX_PRINCIPLE.md`** | **First. Before anything else. Then re-read at every major decision.** |
| `BUILD_INSTRUCTIONS.md` (this doc) | Front to back once, then by phase |
| `BLACK_BOX_LITE_SPEC.md` | Once, for context on the product |
| `BLACK_BOX_LICENSING_AND_PROTECTION.md` | Before W10 (open-source release). Once for understanding. |
| `BLACKBOX_SOFTWARE_SPEC.md` | Reference for every phase |
| `PWA_INTERFACE_SPEC.md` | Heavily during W1, W7, W9 |
| `AUTHORITY_VIEW_SPEC.md` | During W7 (dashboard) and post-MVP outreach |
| `BLACK_BOX_HARDWARE_ROADMAP.md` | Background; not needed for software build |
| `BLACKBOX_SUPPLY_CHAIN.md` | Background; not needed for software build |
| `BLACK_BOX_CAPABILITY_EXPANSION.md` | Post-MVP feature roadmap |
| `BLACK_BOX_LAST_RESORT_PROTOCOL.md` | Post-MVP, for Guardian tier planning |
| `blackbox_mockup.html` | Visual reference during UI work |
| `blackbox_full_preview.html` | Show stakeholders, reference during W7 |
| `blackbox_line_alert.html` | Reference during W6 (bot work) |
| `blackbox_framework.html` | Whole-system reference |

---

## 3. Pre-flight checklist

Do all of this **before** running the W1 prompt. Skipping anything here will block you mid-phase.

### 3.1 Accounts to create

- [ ] **Cloudflare** account — https://dash.cloudflare.com/sign-up (free)
- [ ] **GitHub** account (free)
- [ ] **Apple Developer** Program — https://developer.apple.com/programs/ ($99/yr; not needed until W8 but the activation takes ~24h, so start now)
- [ ] **Domain registrar** account (Namecheap, Cloudflare Registrar, or whatever you prefer)
- [ ] **Anthropic API** account for testing BYOK — https://console.anthropic.com/ (or OpenAI, or Gemini — pick one for your own testing)
- [ ] **Telegram** account (you already have one, probably)
- [ ] **LINE Developers** account — https://developers.line.biz/ (free; needed for the Japan-market bot in W6)

### 2.2 Tools to install

```bash
# Node 20+ (use nvm to manage versions)
nvm install 20
nvm use 20

# pnpm (faster than npm, better monorepo support)
npm install -g pnpm@latest

# Wrangler (Cloudflare CLI)
npm install -g wrangler

# Claude Code
npm install -g @anthropic-ai/claude-code

# Verify
node --version    # should be v20.x or higher
pnpm --version    # should be 9.x
wrangler --version
claude --version  # or: claude-code --version
```

### 2.3 Cloudflare login

```bash
wrangler login
# Opens browser for OAuth, returns to terminal when done
```

### 2.4 Domain decision

Pick one:
- **Option A: Buy a domain now.** Suggested: `getblackbox.com`, `blackbox.safety`, `blackboxapp.com`, or whatever's available and you like. Buy via Cloudflare Registrar for cheapest renewals.
- **Option B: Skip domain for now.** Use Cloudflare's free `*.pages.dev` subdomain (will look like `blackbox-app.pages.dev`). You can attach a domain later.

If buying: also create the Cloudflare zone and update nameservers at your registrar. Takes 24h to propagate.

### 2.5 Repository decision

```bash
# Pick a path. This will be your project root.
mkdir -p ~/code/blackbox
cd ~/code/blackbox

# Initialize an empty git repo here (Claude Code will populate it)
git init
```

You can make this a GitHub repo later, after W1, when there's something to push.

### 2.6 Pre-flight verification

Before starting W1, confirm all of these are true:

- [ ] `node --version` shows 20+
- [ ] `pnpm --version` shows 9+
- [ ] `wrangler whoami` shows your Cloudflare account
- [ ] `claude --version` works
- [ ] You have a project directory at `~/code/blackbox` (or wherever)
- [ ] You have all four spec documents accessible (in the directory or elsewhere you can reference)
- [ ] You have at least one AI provider API key ready to test BYOK in W3 (Anthropic recommended for self-testing)

If any of those fail, fix before continuing. Mid-phase debugging of pre-flight issues is painful.

---

## 3. Universal phase pattern

Every phase follows the same loop:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. READ — Read the spec sections for this phase             │
│ 2. PROMPT — Run the kickoff prompt with Claude Code         │
│ 3. WATCH — Review what Claude Code does; answer questions   │
│ 4. VERIFY — Run the acceptance tests yourself               │
│ 5. COMMIT — git commit when verified                        │
│ 6. PAUSE — Don't run the next phase until you've verified   │
└─────────────────────────────────────────────────────────────┘
```

**Critical rule:** Do not let Claude Code start phase W(n+1) until you've verified phase W(n) acceptance criteria. The phases are designed to be independently verifiable. Skip-ahead bugs compound badly.

---

## 4. Phase W1 — Foundation

### 4.1 Goal
A deployable PWA shell. Installable to phone home screen. Empty inside.

### 4.2 Read first
- `BLACKBOX_SOFTWARE_SPEC.md` sections 1–2 (tech stack, repo structure)
- `BLACK_BOX_LITE_SPEC.md` (product context)
- `PWA_INTERFACE_SPEC.md` sections 2–3 (design tokens, signature element)

### 4.3 The W1 prompt

Open a terminal in `~/code/blackbox`. Run `claude`. Paste this verbatim:

```
You are building BLACK BOX, a personal safety PWA. Read these files in full before writing any code:

1. BLACK_BOX_PRINCIPLE.md  <-- READ THIS FIRST. It is the foundation.
2. BLACKBOX_SOFTWARE_SPEC.md
3. BLACK_BOX_LITE_SPEC.md
4. PWA_INTERFACE_SPEC.md

The principle in document 1 is the constraint that shapes every design decision. Summarize it back to me before starting work, so I know you understood it.

Confirm the locked tech stack in section 1 of BLACKBOX_SOFTWARE_SPEC.md.

For this session, implement ONLY Phase W1 — Foundation. Do not start W2 under any circumstances.

W1 deliverables:
- pnpm monorepo with workspaces for apps/pwa, workers/api, packages/shared
- Vite 5 + React 18 + TypeScript (strict) + Tailwind 3 + shadcn/ui in apps/pwa
- vite-plugin-pwa for service worker
- Web manifest with icons (192, 512, maskable) — generate placeholder icons or use SVG
- Three placeholder routes: / (home), /onboarding, /settings
- Home route shows wordmark "BLACK BOX" and a placeholder status disc that pulses amber (per PWA_INTERFACE_SPEC §3)
- Tailwind config extends design tokens from PWA_INTERFACE_SPEC §2
- IBM Plex font family loaded via @fontsource
- Hono framework Worker scaffold in workers/api/ with wrangler.toml
- packages/shared/ with Zod schemas placeholder
- README.md with setup instructions
- .gitignore appropriate for this stack
- LICENSE file: AGPL-3.0 (per BLACK_BOX_LICENSING_AND_PROTECTION.md)

Build per the principle: single sale, humanized, people-first. No analytics. No telemetry. No tracking scripts. No retention loops. No engagement mechanics.

When complete, deploy the PWA to Cloudflare Pages using wrangler. Output the live URL.

After deployment, stop and ask me to verify the W1 acceptance criteria before doing anything else.

Ask me clarifying questions before starting if any of the requirements are ambiguous.
```

### 4.4 Questions Claude Code will likely ask

- "What is your Cloudflare account ID?" — Find it via `wrangler whoami` or in the Cloudflare dashboard URL
- "What name should I use for the Pages project?" — Suggest `blackbox-pwa` or `blackbox-lite`
- "Do you want a custom domain or the default *.pages.dev?" — Per your pre-flight decision

### 4.5 W1 acceptance criteria

Run each of these. All must pass before moving to W2.

- [ ] `pnpm install` runs clean from project root
- [ ] `pnpm -F pwa dev` starts the dev server on localhost
- [ ] `pnpm -F pwa build` produces a `dist` directory with no errors
- [ ] PWA is deployed and accessible at the Cloudflare Pages URL
- [ ] On iPhone Safari, you can "Add to Home Screen"
- [ ] On Android Chrome, you see the install prompt
- [ ] Installed PWA launches standalone (no browser chrome)
- [ ] Home screen shows "BLACK BOX" wordmark and an amber-pulsing status disc
- [ ] Tapping the disc does nothing (placeholder — correct)
- [ ] `/settings` and `/onboarding` routes load (can be empty/placeholder)
- [ ] Lighthouse PWA score ≥ 90 (run in Chrome DevTools)

### 4.6 Verify, then commit

```bash
cd ~/code/blackbox
git add -A
git commit -m "W1: foundation — PWA shell deployable"

# Create GitHub repo now if you want
gh repo create blackbox --private --source . --push
```

### 4.7 Common W1 issues

| Symptom | Cause | Fix |
|---|---|---|
| `wrangler deploy` fails with auth error | Not logged in | `wrangler login` |
| Pages deployment succeeds but URL 404s | DNS propagation pending | Wait 5–10 min |
| PWA install prompt not appearing | Manifest missing icons | Verify `manifest.webmanifest` has 192/512/maskable |
| Service worker not registering | HTTPS required | Cloudflare Pages provides HTTPS — make sure you're testing the deployed URL, not localhost |
| iOS Safari won't show "Add to Home Screen" | Missing apple-touch-icon | Add 180×180 apple-touch-icon to public/ |

---

## 5. Phase W2 — Capture

### 5.1 Goal
The PWA can record audio + video + location and save it locally to IndexedDB.

### 5.2 Read first
- `BLACKBOX_SOFTWARE_SPEC.md` section 5, W2 specifically
- `BLACKBOX_SOFTWARE_SPEC.md` section 3 (data models)

### 5.3 The W2 prompt

```
W1 is verified and committed. Now implement Phase W2 — Capture.

Read BLACKBOX_SOFTWARE_SPEC.md sections 5 (W2 phase) and 3 (data models).

W2 deliverables:
- lib/capture/ — MediaRecorder wrapper supporting both audio and audio+video modes
- lib/geolocation/ — watchPosition with high accuracy, configurable polling interval
- lib/storage/ — IndexedDB wrapper with stores: recordings, userConfig (placeholder)
- Permissions flow with clear single-purpose modals: mic, camera, location
- /activation route showing a large activate button
- Tap activate → request permissions if not granted → start 60-second recording
- During recording: show elapsed time, recording indicator, location coordinates updating
- Recording auto-stops at 60s or user can hold-to-cancel (3s hold per spec)
- All audio/video chunks + location points saved to IndexedDB
- /history route to list past recordings with playback

Edge cases to handle:
- User denies permission: show what was missed and how to enable in settings
- Recording in background: use Wake Lock API to keep screen on
- App backgrounded: continue recording where possible (foreground service notification on Android via PWA)

Do NOT implement any cloud upload, AI, transcription, notifications, or BLE in this phase.

Build per the principle: single sale, humanized, people-first. No analytics. No telemetry. No retention loops.

Acceptance: I can tap activate, grant permissions, see a 60-second recording session run end-to-end, and play back the recording in /history.

Stop and ask me to verify before W3.
```

### 5.4 W2 acceptance criteria

- [ ] Permissions modals appear with clear single-purpose copy
- [ ] Recording starts within 500ms of tapping activate
- [ ] Active screen shows elapsed time counting up in IBM Plex Mono
- [ ] Active screen shows location coordinates updating every few seconds
- [ ] Recording auto-stops at 60s
- [ ] Hold-to-cancel works (3-second progress fill)
- [ ] Recording saved to IndexedDB (verify in Chrome DevTools → Application → IndexedDB)
- [ ] `/history` lists the recording with timestamp
- [ ] Playback in history works (audio at minimum, video if your device camera was active)
- [ ] iOS Safari recording works when app is foreground
- [ ] Battery doesn't drain catastrophically (record several 60s sessions; verify reasonable)

### 5.5 Verify, commit, pause

```bash
git add -A && git commit -m "W2: capture — audio/video/GPS to IndexedDB"
```

---

## 6. Phase W3 — BYOK + AI Router

### 6.1 Goal
User enters their AI provider's API key. App stores it encrypted locally. App can make a successful classification call directly from browser to provider.

### 6.2 Read first
- `BLACKBOX_SOFTWARE_SPEC.md` W3 section
- `BLACK_BOX_LITE_SPEC.md` BYOK section

### 6.3 The W3 prompt

```
W2 verified and committed. Implement Phase W3 — BYOK + AI Router.

Reference BLACKBOX_SOFTWARE_SPEC.md W3 section and BLACK_BOX_LITE_SPEC.md.

W3 deliverables:
- packages/ai-router/ — provider abstraction with unified interface
- Provider implementations: openai, anthropic, gemini, groq, ollama
- Each provider has the same method signature: classify(transcript: string, context: Context) returns Classification
- lib/crypto/ — AES-GCM encryption for API keys, key derived from user passphrase via PBKDF2 (100,000 iterations, SHA-256)
- /settings → AI Provider section with: provider picker, API key entry (masked input), model selector, "Test" button
- On first key entry, user is prompted to set an unlock passphrase
- Encrypted key stored in IndexedDB under userConfig
- Test button makes a real API call with the configured provider and shows success or specific error
- On app launch with stored encrypted key, prompt for passphrase to unlock (with "Remember for 24h" option using sessionStorage)

Security requirements (non-negotiable):
- API key never logged, never sent to any server other than the user's chosen AI provider
- Plaintext key only exists in memory during active classification calls
- Encrypted key in IndexedDB must be unrecoverable without the passphrase

Build per the principle: user's AI, user's bill, user's data. The key never touches our servers. The system must work fully with no AI configured (local floor in W4 will be the fallback). No telemetry on which providers users choose.

Acceptance: I can enter an Anthropic API key, set a passphrase, hit Test, see a real successful response. Restart the PWA, prompt for passphrase, can test again.

Stop and verify before W4.
```

### 6.4 W3 acceptance criteria

- [ ] Settings → AI Provider section exists
- [ ] All 5 provider options shown
- [ ] API key input is masked (password-style)
- [ ] Passphrase prompt appears on first key entry
- [ ] "Test" button calls the actual AI provider API and returns success or specific error
- [ ] Key persists across PWA restarts (verify in IndexedDB DevTools — should be encrypted ciphertext, not readable)
- [ ] Passphrase prompt appears on PWA restart
- [ ] "Remember for 24h" option works (sessionStorage)
- [ ] CORS errors handled gracefully if a provider's API doesn't allow direct browser calls (Anthropic does; some others may need proxy — note in spec)

### 6.5 Verify, commit

```bash
git add -A && git commit -m "W3: BYOK — encrypted local AI keys, multi-provider router"
```

---

## 7. Phase W4 — Local Transcription + Classifier

### 7.1 Goal
The PWA transcribes audio in-browser (no upload), runs a local keyword classifier on the transcript, and shows the result in the active recording UI.

### 7.2 The W4 prompt

```
W3 verified and committed. Implement Phase W4 — Local Transcription + Classifier.

Reference BLACKBOX_SOFTWARE_SPEC.md W4 section.

W4 deliverables:
- lib/transcription/ — Web Speech API wrapper with auto-restart for long sessions
- packages/classifier/ — local keyword + tone classifier
- Keyword categories with weighted scoring:
  - weapon: gun, knife, weapon, blade, shoot, stab
  - violence: hit, beat, kill, hurt, fight, attack
  - restraint: stop, no, please, don't, let me go
  - compliance: I'll do, whatever you want, please, okay
  - fear: scared, terrified, afraid, help
  - medical: heart, breath, dying, allergic, bleeding
- Tone analysis: RMS volume detection, pitch elevation, speaker activity
- Fusion logic combining keywords + tone into threat level: unknown/low/medium/high/critical
- During active recording, transcript scrolls in active UI with classification overlay
- If user has AI configured: also send transcript to AI provider for richer summary (in addition to local floor)
- Both local and AI classifications stored with recording in IndexedDB

Build per the principle: the local floor is the most important feature in this phase. It is what protects users who have no AI key, no internet, no subscription, nothing but the app. Make it robust. Make the keyword libraries thoughtful (and multilingual where possible — start with English, add Japanese as Japan is launch market).

Acceptance: Speak "Please don't hurt me, I'll do what you want" into the mic during an activation. Local classifier flags restraint + compliance + fear, threat level MEDIUM. If AI is configured, AI summary also appears with richer context.

Stop and verify before W5.
```

### 7.3 W4 acceptance criteria

- [ ] Transcript appears in real-time during recording
- [ ] Web Speech API works on Chrome and Safari (note: limited Safari support; show "transcription unavailable" if unsupported)
- [ ] Local classifier flags appear with category labels
- [ ] Threat level computed and displayed
- [ ] If AI provider configured, AI summary appears within ~3 seconds of significant transcript change
- [ ] Both local and AI classifications saved alongside recording

### 7.4 Commit

```bash
git add -A && git commit -m "W4: transcription + classifier — local floor + AI enhancement"
```

---

## 8. Phase W5 — Cloudflare Worker + R2 + D1

### 8.1 Goal
Backend can receive recording chunks, store them in R2, and track events in D1. Signed URLs let viewers retrieve audio without exposing the bucket.

### 8.2 The W5 prompt

```
W4 verified and committed. Implement Phase W5 — Worker + R2 + D1.

Reference BLACKBOX_SOFTWARE_SPEC.md W5 section, section 4 (API contracts).

W5 deliverables:
- workers/api/ Hono framework setup
- D1 database with migration creating tables: events, devices, contacts, audit_log
- R2 bucket for media chunks
- Endpoints implemented:
  - POST /v1/events — create event, return eventId + signed upload URLs
  - POST /v1/events/:id/chunks — upload audio/video chunk
  - POST /v1/events/:id/location — append location point (batched ok)
  - GET /v1/events/:id — get event with signed URLs (auth required)
  - POST /v1/dashboard/tokens — mint dashboard read token
- HMAC auth middleware for all PWA→Worker calls using user-derived secret
- Chunked upload from PWA: parallel uploads with retry on failure, network-resilient
- R2 signed URLs with TTL (default 24h, configurable per event)

During an activation in the PWA:
- Create event on activation start
- Upload chunks as they're recorded (don't wait until end)
- Append location points every 5s stationary, 1-2s moving
- Save eventId locally; can be retrieved later for sharing

Build per the principle: cloud is for convenience and broadcast, not for required storage. The local IndexedDB copy (from W2) is the source of truth on the user's side. If the cloud upload fails, the recording still exists locally. Add a fallback path for OAuth-based upload to user's own iCloud/Drive in a later phase (post-MVP).

Acceptance: I activate, recording uploads in real-time to R2 (verify in Cloudflare dashboard), event appears in D1, signed URL works to retrieve audio.

Stop and verify before W6.
```

### 8.3 W5 acceptance criteria

- [ ] D1 database created, tables visible in Cloudflare dashboard
- [ ] R2 bucket created
- [ ] PWA can create an event via API
- [ ] Chunks upload as recording progresses (visible in R2 dashboard)
- [ ] Location points POST successfully
- [ ] Signed URL returns audio content when fetched
- [ ] HMAC auth rejects unauthenticated requests
- [ ] Upload retries work if network drops during recording

### 8.4 Commit

```bash
git add -A && git commit -m "W5: Worker + R2 + D1 — real-time cloud upload"
```

---

## 9. Phase W6 — LINE + Telegram Bots

### 9.1 Goal
Contact gets a rich LINE or Telegram message within 5 seconds of activation. Message contains location pin, 3-second audio preview, and dashboard link.

### 9.2 Read first
- `BLACKBOX_SOFTWARE_SPEC.md` W6 section
- `blackbox_line_alert.html` (the LINE mockup for reference)

### 9.3 Pre-W6 setup (do these before running the prompt)

**Create the Telegram bot:**
1. Open Telegram, message `@BotFather`
2. Send `/newbot`
3. Pick a name: "BLACK BOX Safety" (display name) and a username like `blackbox_safety_bot`
4. Save the token BotFather gives you — long string starting with digits and a colon

**Create the LINE bot:**
1. Go to https://developers.line.biz/console/
2. Create a Provider (your organization)
3. Create a Messaging API channel
4. Get the **Channel Access Token** and **Channel Secret**
5. Set webhook URL placeholder (will set real URL after W6 deploys)

### 9.4 The W6 prompt

```
W5 verified and committed. Implement Phase W6 — LINE + Telegram Bots.

Reference BLACKBOX_SOFTWARE_SPEC.md W6 section. Reference the visual mockup blackbox_line_alert.html for the LINE message format.

I have created:
- Telegram bot with token: <I'll add this when I run the prompt>
- LINE bot with channel access token: <I'll add this>
- LINE channel secret: <I'll add this>

W6 deliverables:
- workers/bot/ Worker handling both Telegram and LINE webhooks
- Telegram bot flow:
  - /start command registers a chat
  - User receives a pairing code; they share it with the BLACK BOX user
  - PWA's contact-management UI accepts the pairing code and links the contact's Telegram chat ID
  - On activation, bot sends rich message: alert text, location pin (native Telegram location), audio voice message (3-second clip), inline button to dashboard URL, "I am responding" inline button
- LINE bot flow:
  - User adds the bot as friend
  - Same pairing code flow
  - Activation sends LINE Flex Message: rich card with alert banner, location map, audio clip preview, big "OPEN LIVE DASHBOARD" button, quick reply buttons ("I'm responding", "Call 110", "Share alert")
- Acknowledgment tracking: when contact taps "I am responding," POST to /v1/events/:id with the ack; status flows back to the user's dashboard and the live view
- Set webhook URLs in Telegram and LINE consoles after deployment

Secrets to be stored via `wrangler secret put`:
- TELEGRAM_BOT_TOKEN
- LINE_CHANNEL_ACCESS_TOKEN  
- LINE_CHANNEL_SECRET

Acceptance: End-to-end test — I trigger an activation, my designated test contact receives a LINE or Telegram message within 5 seconds, location is pinned, audio plays, link to dashboard works.

Stop and verify before W7.
```

### 9.5 W6 acceptance criteria

- [ ] Telegram bot replies to /start command
- [ ] LINE bot accepts friend add
- [ ] Pairing flow works end-to-end (contact gets code, user enters it, link confirmed)
- [ ] On activation, message arrives in Telegram/LINE within 5 seconds
- [ ] Location pin renders in message
- [ ] Audio preview is playable
- [ ] Dashboard link opens (will 404 until W7; that's expected)
- [ ] "I am responding" button works (server receives the ack)
- [ ] Tested with at least one real contact's phone, not just your own test account

### 9.6 Commit

```bash
git add -A && git commit -m "W6: LINE + Telegram bots — rich activation alerts"
```

---

## 10. Phase W7 — Dashboard with Share

### 10.1 Goal
Contact taps the link in LINE/Telegram → live dashboard opens → live audio + transcript + location + classification updating in real-time → contact can tap Share to propagate.

### 10.2 Read first
- `BLACKBOX_SOFTWARE_SPEC.md` W7 section
- `blackbox_full_preview.html` (the full interface preview)
- `AUTHORITY_VIEW_SPEC.md` sections 4–5 (for the share-tier system)

### 10.3 The W7 prompt

```
W6 verified and committed. Implement Phase W7 — Dashboard with Share.

Reference BLACKBOX_SOFTWARE_SPEC.md W7. Reference blackbox_full_preview.html for the visual target. Reference AUTHORITY_VIEW_SPEC.md sections 4-5 for the token tier system.

W7 deliverables:
- apps/dashboard/ — separate PWA build (lighter, no recording capabilities)
- Read-token auth (no user login required for the contact)
- Token tiers: contact, authority, public — each renders differently
- Live map with Leaflet + OpenStreetMap tiles, user pin with accuracy circle, trail of recent positions
- Live audio playback streaming from R2 with <5s latency
- Live transcript area updating as new segments arrive
- Live AI summary updating
- Threat-level color coding per design tokens
- "Listening since X:XX" indicator
- Cloudflare Durable Objects for websocket-based live updates
- SHARE button prominent at bottom — native navigator.share() API
- When SHARE is tapped, a custom share sheet renders FIRST showing:
  - Top: "Emergency Dispatch" block with local emergency number (resolve from event location → country → emergency number lookup; 110 Japan, 911 US, 112 EU, etc.); tap dials + copies link to clipboard
  - Below: standard share channels via navigator.share() falling back to a custom grid
- Each share creates a new sub-token via POST /v1/dashboard/tokens with reduced tier (default: same tier, max 50 re-shares per chain)
- User can revoke all tokens from their PWA's event-history view

Authority view (when token is authority-tagged):
- Dispatch summary block at top, AI-generated, tap-to-copy
- Multi-format coordinates (decimal, DMS, Plus Code) each tap-to-copy
- Subject identification (if user pre-registered descriptors)
- Forwarding witness contact info with one-tap dial/message
- Nearest response resources (auto-lookup nearest police station via OSM Overpass API or similar)
- "I am responding" CTA

Acceptance: I activate, contact opens dashboard URL on their phone, sees everything live. They tap Share, see the share sheet with Emergency Dispatch at top. They share via Telegram to a second test contact. Second contact opens link, sees same live data (or a tier-reduced view).

Stop and verify before W8.
```

### 10.4 W7 acceptance criteria

- [ ] Dashboard URL opens on contact's phone without login
- [ ] Live audio plays with <5s latency
- [ ] Transcript scrolls live
- [ ] Map updates location live, trail visible
- [ ] AI summary updates as transcript progresses
- [ ] Threat level color-coded correctly
- [ ] SHARE button opens custom share sheet
- [ ] Emergency Dispatch block at top, with location-correct emergency number
- [ ] Tap on dispatch row dials the number AND copies link to clipboard
- [ ] Native share works on iOS Safari and Android Chrome
- [ ] Share creates a sub-token, sub-link works
- [ ] Authority view renders differently when token tier is "authority"
- [ ] User can revoke all share tokens from their PWA

### 10.5 Commit

```bash
git add -A && git commit -m "W7: dashboard + share — full live view with exponential propagation"
```

---

## 11. Phase W8 — Capacitor iOS + BLE Pairing

### 11.1 Goal
iOS users have a native app via Capacitor, distributed through TestFlight. The native app pairs with a v0/v1 BLE button and listens for activation in background.

### 11.2 Pre-W8 setup

- [ ] Apple Developer account active (started in pre-flight)
- [ ] Xcode 15+ installed
- [ ] Order a Flic 2 button or generic nRF52 BLE button for testing (Amazon, ~$35)
- [ ] Create App Store Connect app record

### 11.3 The W8 prompt

```
W7 verified and committed. Implement Phase W8 — Capacitor iOS + BLE.

Reference BLACKBOX_SOFTWARE_SPEC.md W8 section.

W8 deliverables:
- Capacitor 6 added to apps/pwa
- iOS project generated via cap add ios
- @capacitor-community/bluetooth-le plugin integrated
- Background mode entitlement: bluetooth-central
- NSBluetoothAlwaysUsageDescription with clear safety-use justification
- Custom BLE GATT service UUID for BLACK BOX devices (define in docs/BLE_PROTOCOL.md)
- Settings → Devices → Pair flow:
  - Scan for BLE devices advertising BLACK BOX service UUID
  - If no BLACK BOX devices, also list Flic-compatible buttons for v0 tier
  - HMAC handshake on first pair, store pairing key
- Background listener: when phone is locked and BLE button is pressed, app wakes, immediately triggers activation flow
- Foreground service notification text (Android via Capacitor): "BLACK BOX is running"
- TestFlight build configuration
- App Store Connect listing draft (description, screenshots, privacy policy URL)

Build the iOS app, run it on a real iPhone, pair with a Flic button, verify background activation works.

Acceptance: iOS app installs via TestFlight, pairs with a BLE button, button press triggers activation while phone is locked.

Stop and verify before W9.
```

### 11.4 W8 acceptance criteria

- [ ] iOS app builds without errors
- [ ] TestFlight build distributed (to yourself initially)
- [ ] App launches on physical iPhone (won't fully work in simulator due to BLE)
- [ ] BLE pairing flow finds the test button
- [ ] HMAC handshake completes
- [ ] Button press while phone locked wakes app and triggers activation
- [ ] Recording starts immediately on button press
- [ ] App passes App Review submission requirements (may not approve until W9, but should pass automated checks)

### 11.5 Commit

```bash
git add -A && git commit -m "W8: Capacitor iOS + BLE — TestFlight distribution"
```

---

## 12. Phase W9 — Polish + Beta

### 12.1 Goal
Onboarding works for non-technical users in under 5 minutes. Error handling is graceful. Privacy policy and ToS exist. 5–10 beta testers running it.

### 12.2 The W9 prompt

```
W8 verified and committed. Implement Phase W9 — Polish + Beta.

Reference BLACKBOX_SOFTWARE_SPEC.md W9 section. Reference PWA_INTERFACE_SPEC.md §7 for onboarding flow.

W9 deliverables:
- Onboarding wizard with five steps:
  1. Welcome (explain what BLACK BOX is and isn't)
  2. Emergency Contacts (add 1-3, generate pairing codes for LINE/Telegram)
  3. AI Provider (BYOK setup OR "use free fallback" OR "skip — local-only mode")
  4. Triggers (configure shake sensitivity, voice keyword, etc.)
  5. Practice (run a real practice activation tagged [TEST] in all notifications)
- Settings management for all configuration
- History view with playback and per-event detail
- Cancel + duress phrase configuration
- Privacy policy and terms of service pages (placeholder copy; needs legal review before public launch)
- Error boundaries with friendly recovery
- Retry logic for network failures
- Offline indicators
- Battery optimization: reduce GPS polling when stationary
- App version display in settings
- Open source licenses page

Run a 30-minute end-to-end scripted scenario test:
1. Fresh install
2. Complete onboarding in under 5 minutes  
3. Activate, simulate a 4-minute distress scenario
4. Contact receives, opens dashboard, hits share
5. Cancel via duress phrase test
6. Review history

Acceptance: 5 designated beta testers complete the scripted scenario without crashes or confusion. Collect their feedback in a structured form.

Stop and we will plan launch.
```

### 12.3 W9 acceptance criteria

- [ ] Onboarding takes under 5 minutes for a first-time user
- [ ] All settings are findable and editable
- [ ] No crashes during scripted scenario
- [ ] Offline mode works (recordings save locally, upload when reconnected)
- [ ] Battery usage is reasonable during active recording
- [ ] Beta testers can complete the scenario without your help

### 12.4 Commit

```bash
git add -A && git commit -m "W9: polish + beta — onboarding, error handling, beta-ready"
```

---

## 13. Beta launch

### 13.1 Pre-launch checklist

- [ ] All 9 phases verified and committed
- [ ] Privacy policy reviewed by a lawyer (or use a template like Termly with manual review)
- [ ] Terms of service same
- [ ] Apple App Store submission accepted
- [ ] Google Play submission accepted (if also doing Android native; PWA-only Android is fine for MVP)
- [ ] Domain configured, HTTPS working
- [ ] Beta tester list assembled — 5-10 people who'll actually test in realistic scenarios
- [ ] Feedback form ready (Google Form, Typeform, etc.)
- [ ] Bug tracking set up (GitHub Issues is fine for solo)
- [ ] Analytics minimal — privacy-respecting (Plausible, Umami) or none

### 13.2 Beta tester instructions

Send each tester:
1. Link to the PWA / TestFlight invitation
2. One-page onboarding guide (PDF)
3. Three scenarios to test:
   - Scenario A: Solo walk home at night, simulated panic
   - Scenario B: Test with a friend playing aggressor (with consent)
   - Scenario C: Hardware trigger if you've shipped them a v0 button
4. Feedback form link
5. Your direct contact for issues

### 13.3 First two weeks of beta

- Daily check-in on activations (visible to you in admin view; you'll need to build one in W10+)
- Weekly tester call (30 min, ask what surprised them)
- Triage bugs into: ship-blocker / launch-blocker / nice-to-have
- Iterate

---

## 14. Reference: phase-summary cheat sheet

| Phase | Goal | Time | Acceptance signal |
|---|---|---|---|
| W1 | PWA shell deployable | 1 wknd | Installs to homescreen, shows BLACK BOX |
| W2 | Capture works | 1 wknd | 60s recording saved to IndexedDB |
| W3 | BYOK works | 0.5 wknd | API key encrypted locally, test call succeeds |
| W4 | Transcription + classifier | 0.5 wknd | Speak distress phrase, threat level shows |
| W5 | Worker + R2 + D1 | 1 wknd | Chunks upload live during recording |
| W6 | LINE + Telegram bots | 1 wknd | Contact receives message within 5s |
| W7 | Dashboard + share | 1 wknd | Contact opens dashboard, sees live, shares |
| W8 | Capacitor iOS + BLE | 1-2 wknds | TestFlight build pairs with BLE button |
| W9 | Polish + beta | 1 wknd | 5 testers complete scenario without help |

---

## 15. When things break: triage guide

| Symptom | First check | Then check |
|---|---|---|
| PWA won't install on iPhone | Manifest icons | apple-touch-icon present |
| Recording fails on iOS | HTTPS in use | Mic permission granted |
| AI test call fails | API key valid | CORS — try via Worker proxy |
| Telegram message not arriving | Bot token valid | Webhook URL set correctly |
| LINE message not arriving | Channel access token valid | Webhook URL set, friend added |
| Dashboard 404 | Dashboard PWA deployed | Token valid (not expired) |
| iOS BLE not pairing | Permission granted | Background mode entitlement |
| Anything weird and intermittent | Recent commit | Cloudflare deployment status |

### 15.1 General debugging principle

If something breaks: **revert to the last green commit, then re-do the change in smaller pieces.** Don't try to debug a 500-line Claude Code change in place. Roll back, ask Claude Code to redo with smaller scope.

---

## 16. After MVP — what's next

Once W9 ships and beta runs clean:

- **W10:** Open-source release. Push the entire repo to public GitHub under AGPL-3.0. Documentation under CC-BY-SA 4.0. Public launch announcement explaining the principle and the licensing. *See `BLACK_BOX_LICENSING_AND_PROTECTION.md` for the full strategy.*
- **W11:** Hardware v0 launch — order Flic 2 white-labels, list on a Shopify storefront
- **W12:** v1 Sentinel cube — industrial design, prototype run, certifications start
- **W13+:** Authority partnership outreach using `AUTHORITY_VIEW_SPEC.md` as the pitch document
- **Year 2:** v2 Recorder development (separate firmware spec needed). Begin foundation transition planning.
- **Year 3+:** Establish non-profit foundation per licensing-and-protection doc. Transfer trademark and patents. Make principle structurally durable.

---

## 17. The final rule

**Don't skip phases. Don't sprint two phases in one session. Verify each one.**

The phases are designed so that if W3 is broken, W2 still works. If W7 is broken, W5 and W6 still work. Cascading dependencies are intentional and minimal. Respect them and the build stays sane.

**Every phase ships per the principle:**
- Single sale, no subscriptions
- Humanized thought
- Human benefit, measured in outcomes not metrics
- Not profit-driven per se
- Not exploitative
- People first

If you ever find yourself adding analytics, retention loops, paid tiers on the software, advertising, or anything else that conflicts with the principle — stop, re-read `BLACK_BOX_PRINCIPLE.md`, and decide whether the feature should ship at all.

Good luck. Ship something good.

---

**End of build runbook.**
