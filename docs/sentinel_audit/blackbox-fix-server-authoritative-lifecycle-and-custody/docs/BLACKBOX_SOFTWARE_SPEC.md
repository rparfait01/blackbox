# BLACK BOX — Software Build Spec

**Version:** 1.0
**Status:** Ready for build
**Target builder:** Claude Code (`@anthropic-ai/claude-code`)
**Docs:** https://docs.claude.com/en/docs/claude-code/overview

---

## 0. Product overview

BLACK BOX is a personal safety system: a wearable hardware trigger paired with a Progressive Web App that, on activation, records audio/video/location locally, streams to a live dashboard, and notifies emergency contacts via free messaging channels. The user brings their own AI key (BYOK) for situational classification — no recurring fees, no vendor lock-in.

**Product pitch:**
> BLACK BOX is not indestructible. It is interruption-resistant. If someone tries to break it, the break becomes the signal.

**Software-side promise:**
- One-time purchase, no subscription
- User's data goes to their own AI provider
- Audio never leaves the device except for authorized dashboard playback
- Works offline (local transcription + local keyword classifier as floor)

---

## 1. Locked tech stack

Do not change these without explicit approval — they are load-bearing decisions.

### Frontend (PWA)
- **Framework:** React 18 + Vite 5
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS 3 + shadcn/ui components
- **State:** Zustand (lightweight, no boilerplate)
- **Routing:** React Router 6
- **Forms:** React Hook Form + Zod validation
- **Maps:** Leaflet + OpenStreetMap tiles (no API key required)
- **PWA tooling:** vite-plugin-pwa
- **Encryption (BYOK keys at rest):** Web Crypto API (AES-GCM, key derived from user passphrase via PBKDF2)

### Backend (edge)
- **Runtime:** Cloudflare Workers (paid plan optional, free tier sufficient for MVP)
- **Storage (objects):** Cloudflare R2 — audio/video chunks, no egress fees
- **Storage (relational):** Cloudflare D1 (SQLite at edge) for event metadata, device registry, audit trail
- **Realtime:** Cloudflare Durable Objects for live dashboard websocket connections
- **KV cache:** Cloudflare KV for short-lived dashboard tokens

### iOS (Capacitor wrapper)
- **Wrapper:** Capacitor 6
- **BLE plugin:** `@capacitor-community/bluetooth-le`
- **Background mode:** `bluetooth-central`
- **Build target:** iOS 16.4+ (for Web Push support)

### Messaging integrations
- **Primary:** Telegram Bot API (free, unlimited)
- **Japan:** LINE Messaging API (free tier 1,000 msgs/month)
- **Universal fallback:** Web Push API (built into PWA)
- **Email:** Resend (3K/month free) or AWS SES (paid)
- **SMS (paid fallback only):** Twilio

### AI providers (BYOK abstraction layer)
- OpenAI (`/v1/chat/completions`)
- Anthropic (`/v1/messages`)
- Google Gemini (`/v1beta/models`)
- Groq (OpenAI-compatible)
- Ollama (local endpoint, OpenAI-compatible)
- Free-tier fallback: Gemini Flash via shared rate-limited key

### Transcription
- **Primary:** Web Speech API (`webkitSpeechRecognition`)
- **Fallback (v1.5):** `whisper.wasm` via `@xenova/transformers`

---

## 2. Repository structure

Monorepo using pnpm workspaces.

```
blackbox/
├── apps/
│   ├── pwa/                       # Main PWA (user-facing)
│   │   ├── src/
│   │   │   ├── components/        # UI components
│   │   │   ├── routes/            # Page routes
│   │   │   │   ├── Onboarding/
│   │   │   │   ├── Home/
│   │   │   │   ├── Settings/
│   │   │   │   ├── Activation/    # Active emergency UI
│   │   │   │   └── History/
│   │   │   ├── lib/
│   │   │   │   ├── activation/    # Trigger orchestration
│   │   │   │   ├── ai-router/     # BYOK provider abstraction
│   │   │   │   ├── ble/           # Bluetooth (web + Capacitor)
│   │   │   │   ├── capture/       # MediaRecorder wrapper
│   │   │   │   ├── classifier/    # Local keyword + tone
│   │   │   │   ├── crypto/        # Encryption for BYOK keys
│   │   │   │   ├── geolocation/   # Position streaming
│   │   │   │   ├── notification/  # Channel router
│   │   │   │   ├── storage/       # IndexedDB wrapper
│   │   │   │   ├── transcription/ # Speech-to-text
│   │   │   │   └── upload/        # Chunked R2 upload
│   │   │   ├── stores/            # Zustand stores
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   ├── public/
│   │   │   ├── manifest.webmanifest
│   │   │   ├── icons/             # PWA icons all sizes
│   │   │   └── sw.js              # Service worker
│   │   ├── ios/                   # Capacitor iOS project
│   │   ├── capacitor.config.ts
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── dashboard/                 # Emergency contact view
│       └── (same structure, simpler)
│
├── workers/
│   ├── api/                       # Main API Worker
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── events.ts      # Activation event CRUD
│   │   │   │   ├── uploads.ts     # R2 signed URLs
│   │   │   │   ├── dashboard.ts   # Read-token auth, live state
│   │   │   │   └── devices.ts     # BLE device registration
│   │   │   ├── lib/
│   │   │   │   ├── d1/
│   │   │   │   ├── r2/
│   │   │   │   └── auth/
│   │   │   ├── durable-objects/
│   │   │   │   └── LiveSession.ts
│   │   │   └── index.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   └── bot/                       # Telegram + LINE bot Worker
│       ├── src/
│       │   ├── telegram/
│       │   ├── line/
│       │   └── index.ts
│       └── wrangler.toml
│
├── packages/
│   ├── shared/                    # Cross-app types + schemas
│   │   └── src/
│   │       ├── types/
│   │       └── schemas/           # Zod schemas
│   │
│   ├── ai-router/                 # Standalone BYOK router (testable)
│   │   └── src/
│   │       └── providers/
│   │           ├── openai.ts
│   │           ├── anthropic.ts
│   │           ├── gemini.ts
│   │           ├── groq.ts
│   │           └── ollama.ts
│   │
│   └── classifier/                # Local classifier (testable)
│       └── src/
│           ├── keywords.ts
│           ├── tone.ts
│           └── fusion.ts
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── BLE_PROTOCOL.md            # Device pairing + activation packet spec
│   ├── BYOK_SECURITY.md           # Key handling, encryption details
│   ├── DEPLOYMENT.md
│   └── NOTIFICATION_POLICIES.md   # Cascade rules, duress, cancel
│
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## 3. Data models

All shared types live in `packages/shared/src/types/`. Validation via Zod schemas in `packages/shared/src/schemas/`.

### User configuration (IndexedDB, encrypted)

```typescript
interface UserConfig {
  userId: string;                  // UUID v4
  displayName: string;
  createdAt: number;               // Unix ms
  emergencyContacts: Contact[];
  aiProvider: AIProviderConfig | null;
  triggers: TriggerConfig;
  pairedDevices: BlackBoxDevice[];
  duressPhrase?: string;           // Spoken to fake-cancel (continues recording silently)
  cancelPhrase: string;            // Real cancel
  dashboardReadTokens: DashboardToken[];
  retention: {
    audioDays: number;             // Default 30
    eventLogDays: number;          // Default 365
  };
}

interface Contact {
  id: string;
  name: string;
  relationship: string;
  priority: number;                // 1 = primary
  channels: {
    telegramChatId?: string;
    lineUserId?: string;
    webPushSubscription?: PushSubscription;
    email?: string;
    phone?: string;                // SMS via Twilio (paid)
  };
}

interface AIProviderConfig {
  provider: 'openai' | 'anthropic' | 'gemini' | 'groq' | 'ollama' | 'free-fallback';
  encryptedApiKey: string;         // AES-GCM ciphertext, base64
  model: string;
  endpoint?: string;               // For ollama / custom
}

interface TriggerConfig {
  manualButton: boolean;
  shakeDetection: { enabled: boolean; threshold: number };
  voiceKeyword: { enabled: boolean; phrase: string };
  deadmanSwitch: boolean;          // Only if BLE device paired
  checkInTimer: { enabled: boolean; intervalMinutes: number };
}

interface BlackBoxDevice {
  deviceId: string;                // BLE MAC or UUID
  pairingKey: string;              // Shared secret for HMAC auth
  hardwareVersion: string;
  firmwareVersion: string;
  lastBatteryLevel?: number;       // 0-100
  lastSeen: number;
}
```

### Activation event (D1 + R2)

```typescript
interface ActivationEvent {
  eventId: string;                 // UUID v4
  userId: string;
  trigger: TriggerType;
  startTime: number;
  endTime?: number;
  status: 'active' | 'cancelled' | 'resolved' | 'expired';
  audioChunks: ChunkRef[];
  videoChunks: ChunkRef[];
  locationPoints: LocationPoint[];
  transcript: TranscriptSegment[];
  classifications: Classification[];
  notificationDispatches: NotificationDispatch[];
  tamperEvents: TamperEvent[];
  dashboardTokens: string[];       // Active read tokens
}

type TriggerType =
  | 'manual-button'
  | 'shake'
  | 'voice-keyword'
  | 'ble-button'
  | 'ble-deadman'
  | 'ble-tamper'
  | 'ble-last-gasp'
  | 'check-in-timeout';

interface ChunkRef {
  r2Key: string;                   // R2 object key
  timestamp: number;
  durationMs: number;
  byteSize: number;
  mimeType: string;
}

interface LocationPoint {
  timestamp: number;
  lat: number;
  lon: number;
  accuracy: number;                // meters
  altitude?: number;
  speed?: number;                  // m/s
  heading?: number;                // degrees
  batteryLevel?: number;
}

interface TranscriptSegment {
  timestamp: number;
  durationMs: number;
  speakerId?: string;              // Diarization tag
  text: string;
  confidence: number;
  source: 'web-speech' | 'whisper-local' | 'ai-provider';
}

interface Classification {
  timestamp: number;
  source: 'local-keyword' | 'local-tone' | 'ai';
  threatLevel: 'unknown' | 'low' | 'medium' | 'high' | 'critical';
  categories: string[];
  speakerCount: number;
  aggressorDetected: boolean;
  weaponDetected: boolean;
  summary: string;                 // Plain language for dashboard
  rawResponse?: string;            // For audit (AI provider raw)
  confidence: number;
}

interface NotificationDispatch {
  timestamp: number;
  channel: 'telegram' | 'line' | 'webpush' | 'email' | 'sms';
  contactId: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'acknowledged';
  acknowledgedAt?: number;
}

interface TamperEvent {
  timestamp: number;
  channel: 'switch' | 'mesh' | 'photodiode' | 'shock' | 'impedance' | 'last-gasp';
  severity: 'detected' | 'imminent' | 'breach';
  rawData?: Record<string, unknown>;
}
```

---

## 4. API contracts (Cloudflare Worker)

Base URL: `https://api.blackbox.<domain>`

### Public endpoints

```
POST   /v1/events                  # Create activation event
POST   /v1/events/:id/chunks       # Upload audio/video chunk (multipart)
POST   /v1/events/:id/location     # Append location point (batched ok)
POST   /v1/events/:id/transcript   # Append transcript segment
POST   /v1/events/:id/classify     # Append classification
PATCH  /v1/events/:id              # Update event (status, end, etc)
GET    /v1/events/:id              # Get event (auth required)

POST   /v1/dashboard/tokens        # Mint dashboard read token (called from PWA)
GET    /v1/dashboard/:token        # Public dashboard view (read-only)
WS     /v1/dashboard/:token/live   # Live updates via Durable Object

POST   /v1/devices                 # Register paired BLE device
GET    /v1/devices/:id             # Get device status
POST   /v1/devices/:id/telemetry   # Battery, last-seen, etc

POST   /v1/notify                  # Dispatch notification (auth)
POST   /v1/bot/telegram/webhook    # Telegram webhook
POST   /v1/bot/line/webhook        # LINE webhook
```

### Auth model

- PWA → Worker: HMAC-signed requests using user's `pairingKey`-derived secret.
- Dashboard tokens: short-lived (24h max), revocable, single-event scoped.
- Device telemetry: HMAC using device's `pairingKey`.

### Sample payloads

```jsonc
// POST /v1/events
{
  "userId": "uuid",
  "trigger": "manual-button",
  "startTime": 1733673600000,
  "deviceId": "optional-uuid"
}

// Response
{
  "eventId": "uuid",
  "uploadUrls": {
    "audio": "https://...r2.cloudflare.com/...signed",
    "video": "https://...r2.cloudflare.com/...signed"
  },
  "dashboardToken": "short-lived-token"
}
```

---

## 5. Build phases

Build sequentially. Each phase has a hard acceptance criterion before moving to the next.

### Phase W1 — Foundation

**Scope:** Repo, tooling, PWA shell, deployable to Cloudflare Pages.

**Tasks:**
- pnpm workspace setup with `apps/pwa`, `workers/api`, `packages/shared`
- Vite + React + TypeScript + Tailwind + shadcn/ui
- Service worker via vite-plugin-pwa
- Manifest with proper icons (192, 512, maskable)
- Basic routing: `/`, `/onboarding`, `/settings`
- Deploy to Cloudflare Pages

**Acceptance:** Install PWA to iPhone homescreen, launch standalone, see "BLACK BOX" home screen with placeholder activation button.

---

### Phase W2 — Capture

**Scope:** Audio + video + geolocation capture, local buffering.

**Tasks:**
- `lib/capture/` — MediaRecorder wrapper, configurable codec (opus for audio, vp9/h264 for video)
- `lib/geolocation/` — watchPosition with high accuracy, configurable polling
- `lib/storage/` — IndexedDB schema for `recordings`, `userConfig`, `events`
- Permissions flow: clear, single-purpose modals for mic / camera / location
- Activation page: tap button → 60s recording → save to IndexedDB

**Acceptance:** Tap activate, recording runs 60s, audio/video/location all saved locally, playable from history.

---

### Phase W3 — BYOK + AI router

**Scope:** User enters their own AI key, app uses it for classification.

**Tasks:**
- `packages/ai-router/` — provider abstraction with unified interface
- Provider implementations: OpenAI, Anthropic, Gemini, Groq, Ollama
- `lib/crypto/` — AES-GCM encryption for API keys, key derived from user passphrase via PBKDF2 (100k iterations, SHA-256)
- Settings UI: provider picker, key entry (masked), model selector, test button
- Encrypted storage in IndexedDB

**Acceptance:** Enter Anthropic API key, hit "test" button, get successful response from Claude. Reload app, key persists, no plaintext key in storage.

---

### Phase W4 — Transcription + local classifier

**Scope:** Browser-side speech-to-text + keyword/tone classifier as always-on floor.

**Tasks:**
- `lib/transcription/` — Web Speech API wrapper with auto-restart for long sessions
- `packages/classifier/` — keyword matcher with weighted scoring
  - Categories: `weapon`, `violence`, `medical`, `restraint`, `fear`, `compliance-language`
  - Configurable keyword lists per category
- Tone analysis: volume RMS, pitch elevation detection via Web Audio API
- Speaker count via simple voice activity detection (VAD)
- Fusion logic: combine signals into threat level

**Acceptance:** Speak "Please don't hurt me, I'll do what you want" into mic → transcript appears live, local classifier flags as `restraint + compliance-language + fear`, threat level `medium`.

---

### Phase W5 — Cloudflare Worker + R2

**Scope:** Backend storage + upload pipeline.

**Tasks:**
- `workers/api/` — Hono framework, Cloudflare Worker setup
- D1 schema migration with all tables
- R2 bucket setup, signed URL minting
- Chunked upload from PWA (parallel uploads, retry on failure)
- Event CRUD endpoints
- HMAC auth middleware

**Acceptance:** Activation creates event in D1, audio chunks uploaded to R2, retrievable via signed URL with TTL expiration.

---

### Phase W6 — Telegram bot

**Scope:** Free, instant emergency contact notification.

**Tasks:**
- `workers/bot/` — Telegram bot via webhook
- `/start` flow: contact joins bot, gets registration link
- Contact pairing: link user to contact's Telegram chat ID
- On activation: send rich message with location pin, audio playback link, dashboard URL, inline `[ I'm responding ]` button
- Acknowledgment tracking back to event

**Acceptance:** End-to-end: trigger activation → contact receives Telegram message within 5 seconds with location, plays audio, taps "I'm responding" → ack visible in dashboard.

---

### Phase W7 — Dashboard

**Scope:** Live view for emergency contact.

**Tasks:**
- `apps/dashboard/` — separate PWA build (lighter, no recording capabilities)
- Read-token auth (no login required for contact)
- Live map with Leaflet + OSM, user pin with accuracy circle, trail
- Live audio playback (signed URL stream)
- Live transcript with classification overlay
- Threat-level color coding
- "Listening since X:XX" indicator

**Acceptance:** Open dashboard URL on a second device → see user's location updating live, hear audio with <5s latency, transcript appears with classification labels.

---

### Phase W8 — Capacitor iOS + BLE

**Scope:** iOS native wrapper with background BLE pairing.

**Tasks:**
- Capacitor 6 setup, iOS project generation
- `@capacitor-community/bluetooth-le` integration
- Background mode entitlement: `bluetooth-central`
- BLE service definition (custom UUID for BLACK BOX device)
- Pairing flow: scan → select device → HMAC handshake → store pairing key
- Background listening for activation packets
- Wake activation flow when packet received

**Acceptance:** Pair to BLE button via iOS app, lock phone, press BLE button → app wakes in background, activation begins, audio recording starts. TestFlight build distributed to beta testers.

---

### Phase W9 — Polish + beta

**Scope:** Onboarding, error handling, beta-ready.

**Tasks:**
- Onboarding wizard: contacts → AI key → triggers → test activation
- Settings management
- History view with playback
- Cancel + duress phrase configuration
- Privacy policy + terms of service
- Error boundaries, retry logic, offline indicators
- Battery optimization (reduce GPS polling when stationary)

**Acceptance:** Run a 30-minute scripted scenario end-to-end without manual intervention. Ship to 10 beta testers, collect feedback.

---

## 6. BLE protocol (placeholder until firmware spec finalized)

Custom GATT service. Will be detailed in `docs/BLE_PROTOCOL.md` when hardware firmware is locked.

**Service UUID:** `BLACKBOX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (to be assigned)

**Characteristics (planned):**
- Activation packet (notify): trigger type, timestamp, HMAC signature
- Battery level (read): 0-100
- Tamper event (notify): channel, severity
- Device info (read): hardware/firmware version
- Configuration (read/write, authenticated): threshold values, etc.

Software side: implement against a mock first. Hardware integration in W8 only requires the BLE GATT spec to be agreed upon.

---

## 7. Notification policy engine

**BLACK BOX is the system; the messaging services are channels.** LINE, SMS,
email, web/native push, and Telegram are interchangeable *channels*, never the
foundation. A contact is a person with one or more reach endpoints, each
`(channel, channelIdentifier, priority)`; the notification router tries them in
priority order until one delivers. A contact with no LINE is still reachable by
any other endpoint. Adding a channel is implementing one `NotificationChannel`
and registering it — it never requires a schema change or a new code path at the
call sites. No single channel is load-bearing. (In v0 only LINE is implemented;
push/telegram/sms/email exist as stubs the router can route to once built —
native/web **push** is the next to build, as it removes the dependency on any
third-party messaging app entirely.)

User-configurable cascade. Default policy:

1. **T+0s** — Send to all contacts marked `priority: 1` via Telegram + Web Push
2. **T+60s** — If no contact acknowledged via inline button, escalate to priority 2 contacts
3. **T+180s** — Email all configured contacts as durable record
4. **T+300s** — Optional: SMS fallback (Twilio, paid; requires user opt-in)
5. **Continuous** — Live dashboard updates regardless of acknowledgment

**Duress phrase handling:**
- User speaks duress phrase → system shows "Cancelled" on device UI, **continues recording and transmitting silently**, escalates notification with `[DURESS]` tag
- User speaks real cancel phrase → system actually cancels, sends "false alarm" notification to contacts

**No auto-911:** MVP does not contact emergency services directly. Dashboard is for human contacts to assess and call authorities themselves with informed context.

---

## 8. Environment setup

```bash
# Prerequisites
node >= 20
pnpm >= 9
wrangler CLI (Cloudflare)
Xcode 15+ (for iOS build)

# Initial setup
pnpm install
pnpm -F api wrangler login
pnpm -F api wrangler d1 create blackbox-prod
pnpm -F api wrangler r2 bucket create blackbox-media

# Local dev
pnpm dev                           # Runs all apps + workers in parallel
pnpm -F pwa dev                    # Just PWA
pnpm -F api dev                    # Just Worker

# iOS build
pnpm -F pwa build
pnpm -F pwa cap sync ios
pnpm -F pwa cap open ios

# Deploy
pnpm -F api deploy                 # Worker → Cloudflare
pnpm -F pwa deploy                 # PWA → Cloudflare Pages
```

---

## 9. Required environment variables / secrets

### Cloudflare Worker secrets (set via `wrangler secret put`)
- `TELEGRAM_BOT_TOKEN`
- `LINE_CHANNEL_ACCESS_TOKEN` (when added)
- `RESEND_API_KEY` (when email implemented)
- `HMAC_SIGNING_KEY` (rotate quarterly)

### PWA env vars (build-time)
- `VITE_API_BASE_URL` — Worker endpoint
- `VITE_DASHBOARD_BASE_URL` — Dashboard PWA URL

### IndexedDB stores
- `userConfig` (encrypted blob, single record)
- `recordings` (chunked audio/video, awaiting upload)
- `events` (event metadata cache)
- `pendingNotifications` (offline queue)

---

## 10. Non-goals for MVP

Explicit out-of-scope to prevent drift:

- 911 / PSAP integration (huge legal surface)
- Voice biometric speaker identification (Phase 1+)
- Multi-user / household accounts
- Native Android app (PWA on Chrome covers Android)
- Insurance integration
- White-labeling for B2B
- Apple Watch / Wear OS apps
- IR / laser hardware beacon (hardware Phase 2)
- Thermal imaging integration

---

## 11. Acceptance for "MVP complete"

All of the following must be true:

1. PWA installs from public URL on iOS and Android
2. User completes onboarding in under 5 minutes
3. Activation → contact receives Telegram alert within 5 seconds
4. Live dashboard updates with <5s lag for location, transcript, classification
5. BYOK works for at least OpenAI, Anthropic, Gemini, and Groq
6. iOS Capacitor app pairs with a BLE button and triggers in background
7. Audio playback from R2 works in dashboard
8. Duress phrase scenario passes end-to-end test
9. 10 beta testers complete a scripted scenario without crashes
10. No recurring cost dependencies (everything on free tiers at MVP scale)

---

## 12. First Claude Code prompt template

When starting build, open Claude Code in an empty directory and run:

```
Read /path/to/BLACKBOX_SOFTWARE_SPEC.md in full.

Confirm the locked tech stack in section 1.
Set up the monorepo per section 2.
Implement Phase W1 only.
Stop and ask for review when W1 acceptance criteria are met.
Do not start W2 until I confirm.
```

For each subsequent phase, repeat with the next phase number. Do not let phases overlap.

---

**End of spec. Build sequentially. Ship.**
