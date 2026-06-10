# BLACK BOX LITE — Product Spec

**Tier:** PWA-only software product (entry tier)
**Status:** Ready for build · Claude Code can begin immediately
**Companion docs:**
- `BLACK_BOX_PRINCIPLE.md` — the foundation. Read this first.
- `BLACKBOX_SOFTWARE_SPEC.md` — full software build spec (W1–W9 phases)
- `PWA_INTERFACE_SPEC.md` — interface design + design tokens
- `blackbox_mockup.html` — interactive visual reference
- `BLACK_BOX_HARDWARE_ROADMAP.md` — hardware progression (v0/v1/v2)
- `BLACK_BOX_LICENSING_AND_PROTECTION.md` — how the principle is kept from erosion

---

## What BLACK BOX Lite is

A free Progressive Web App that turns the user's existing phone into a personal safety recorder. Captures audio, video, and location on activation. Streams a live shareable dashboard to designated emergency contacts. Bring-your-own-AI architecture means the user's data goes to the AI provider they choose — or stays entirely local.

**The one-line statement of what it is:**
> A personal safety system for people who cannot afford to be safe. Pay once for hardware if you want it. The software is free, and stays free.

---

## What Lite is NOT

To prevent feature creep and to keep the principle intact:

- ❌ Not a recording device that survives phone destruction (that's the v2 Recorder)
- ❌ Not a hidden / deniable system (the phone is the device, attacker sees it)
- ❌ Not 360° capture (single camera, phone-grade)
- ❌ Not forensic-grade evidence (acceptable, not exceptional)
- ❌ Not tamper-protected (no hardware tamper, no last-gasp)

These limitations are **intentional**. They define why someone might choose to add the v1 Sentinel or v2 Recorder hardware — not because Lite is missing protection on purpose, but because some threat models require capabilities a phone alone cannot provide.

**Lite is complete on its own.** It is not a gimped version of the hardware tiers. It is the protection people get if they have a phone, full stop.

---

## The four pillars of Lite

These are not marketing copy. They are constraints on engineering decisions.

### 1. Privacy First
Audio stays on the device. Only text goes to the user's chosen AI provider. The user owns their data. We do not.

### 2. The User's AI, the User's Bill — or No AI at All
User brings their own API key — OpenAI, Anthropic, Google Gemini, Groq, or a local Ollama endpoint. The PWA calls the AI provider *directly from the browser*. The key never touches BLACK BOX servers. Their quota, their bill, their audit trail.

If the user has no AI key and does not want one, the system still works. Local transcription via Web Speech API and a keyword classifier running in JavaScript provide the safety floor. **AI is the enhancement; it is not the floor.**

### 3. Always Works (Local Floor)
Even with no AI configured, even with no internet, the system records audio + video + location to the user's device. Transcribes locally. Classifies locally. The local keyword floor protects users who never configure an AI, never upgrade hardware, never pay anything.

### 4. Single Sale, No Subscriptions
One install. No recurring fees. Ever.

The Lite tier does not have a Pro version that locks features behind a monthly charge. It does not have a "premium" tier on the software. If we add a paid layer later, it will be hardware — never software.

This is in the principle document for a reason. It is not optional.

---

## Architecture (high-level)

```
USER PHONE (PWA)
  ├─ Capture: MediaRecorder (audio + video) + Geolocation
  ├─ Local Processing: Web Speech transcription, keyword classifier
  ├─ Encrypted Storage: IndexedDB for keys, recordings buffer
  └─ Outbound (parallel on activation):
      ├─→ User's AI provider (text only, their key) [optional]
      ├─→ Cloudflare Worker (event creation, signed URL minting)
      ├─→ R2 (media chunks via signed upload) OR user's own cloud via OAuth
      ├─→ Telegram / LINE bot (free, instant contact alerts)
      ├─→ User's own email outbox (fallback channel)
      ├─→ Web Push to registered contacts (free)
      └─→ Dashboard live updates (Durable Object websocket)

CLOUDFLARE EDGE (free tiers — graceful degrade if unavailable)
  ├─ Workers: routing, auth, bot webhooks
  ├─ R2: media object storage (10GB free, no egress)
  ├─ D1: event metadata, audit ledger
  └─ Durable Objects: live dashboard sessions

CONTACTS / AUTHORITIES / PUBLIC
  └─ Open share link → live dashboard
      ├─ Live audio playback (signed R2 URLs)
      ├─ Live transcript + classification
      ├─ Live location + trail (Leaflet + OSM)
      ├─ Notified contacts + acknowledgments
      └─ Share button → exponential propagation
```

Full architecture details in `BLACKBOX_SOFTWARE_SPEC.md`.

**On Cloudflare specifically:** The system uses Cloudflare's free tier because it is generous and the tooling is good. The architecture is designed so that if Cloudflare disappears, the system degrades gracefully to peer-to-peer + local storage + direct user-email/SMS channels — slower and less feature-rich, but functional. The principle requires that no single corporate dependency can hold the system hostage.

---

## Pricing & positioning

| Tier | Price | What it is |
|---|---|---|
| **Lite (PWA only)** | **Free, forever** | Record, transcribe, GPS, Telegram/LINE alerts, local classifier, dashboard with share. The complete protection a phone can give. |
| **v0 Hardware (off-the-shelf BLE button)** | **$79–99 one-time** | Flic 2 white-label trigger + branded packaging. Adds hardware button activation for moments when reaching for the phone isn't possible. |
| **v1 Trigger (BLACK BOX Sentinel cube)** | **$129–179 one-time** | Custom branded BLE trigger device with tamper detection, deadman release, beacon mode. The first hardware that introduces capabilities a phone cannot offer. |
| **v2 Recorder (BLACK BOX Recorder puck)** | **$349–499 one-time** | Full 360° camera/mic recorder. On-device SSD that survives phone destruction. Independent cellular signal. For users whose threat model requires forensic-grade evidence and survivability. |

**No subscription at any tier. Ever. This is the principle, not a marketing promise.**

The hardware funds the software development. Hardware buyers subsidize the protection of every Lite user. That is the entire business model.

---

## Hardware compatibility forward-path

Lite is built to gracefully accept upgrade-tier hardware without breaking compatibility:

- **No hardware:** Lite runs standalone. All triggers are phone-side (manual, shake, voice keyword).
- **v0 Flic 2 / generic BLE button:** Lite pairs via Web Bluetooth (Android) or Capacitor BLE (iOS). Button becomes an additional trigger source.
- **v1 BLACK BOX Sentinel:** Same pairing flow. Adds tamper detection events and deadman-release trigger.
- **v2 BLACK BOX Recorder:** Lite becomes the *relay* — receives stream from device over WiFi Direct, forwards to cloud, hosts dashboard. The device is now the primary recorder; Lite is the bridge.

Same PWA, same dashboard, same share architecture. Hardware appears as upgraded *capability*, not a different product.

A Lite user who never upgrades hardware is not a lesser user. They are a complete user.

---

## Build sequence (already specced)

Per `BLACKBOX_SOFTWARE_SPEC.md`:

- **W1** PWA shell, deployable to Cloudflare Pages
- **W2** Audio + video + GPS capture, IndexedDB buffer
- **W3** BYOK + AI router (multi-provider abstraction, optional)
- **W4** Local transcription + keyword classifier (the floor)
- **W5** Cloudflare Worker + R2 storage (with graceful degrade)
- **W6** Telegram + LINE bot integration
- **W7** Live dashboard with share
- **W8** Capacitor iOS wrapper + BLE pairing
- **W9** Polish, onboarding, beta
- **W10** Open-source release. AGPL license. Public repo. Documentation. *(See `BLACK_BOX_LICENSING_AND_PROTECTION.md`)*

7–10 focused weekends to launchable PWA MVP. Ship Q3 2026.

---

## Marketing copy direction

The Lite landing page does not lead with features. It leads with the principle.

**Hero:**
> BLACK BOX
> Personal safety, single sale.
> The software is free. The hardware is optional. The protection is the point.

**The pillars:**
- **Privacy First** — Audio stays on your device. Only text goes to your AI, if you choose to use one.
- **Your AI, Your Bill — Or No AI** — Bring your own key, use one of the free providers, or skip AI entirely. The local floor protects you either way.
- **Always Works** — Local transcription and keyword detection keep you protected even without internet, AI, or hardware.
- **Single Sale, No Subscriptions** — The software is free, forever. If you want hardware, it's a one-time fee. No tiers. No upsells.

**Competitive context:**

This is the section to handle carefully. Other safety apps are not the enemy. They serve some users well. But their model is the model BLACK BOX exists to challenge.

> Life360: $8–25/mo subscription. Location sharing, alerts.
> bSafe: $5/mo subscription. SOS, tracking.
> Noonlight: $10/mo subscription. Emergency response.
> Apple Emergency SOS: Free. Call for help only.
> **BLACK BOX: Software is free. Hardware is one-time. The user owns their data, their AI, their device.**

The point isn't that other apps are bad. The point is that *for the people who need this most, $8 a month is the difference between protection and going without.* That gap is where we exist.

---

## Open decisions before W1

1. **Domain.** Suggest: `blackbox.app` (verify availability) or `getblackbox.com` or `blackbox.safety`. Locks the share URL format and the brand. Buy via Cloudflare Registrar for cheapest renewals.
2. **Telegram bot username.** Has to be globally unique. Reserve early.
3. **Open source license decision.** Default recommendation: AGPL-3.0 for the code, CC-BY-SA for the documentation. Final call needs founder confirmation before W10.
4. **Apple Developer account.** $99/yr — required before W8. Open this now even if you don't need it yet.

---

## The non-negotiable rules (restated from the principle)

Engineering and product decisions on the Lite tier follow these:

- No feature ever moves behind a recurring fee.
- No advertising. Anywhere. Ever.
- No telemetry beyond what is required to operate the service.
- No retention loops. No streaks. No "you haven't opened the app in 30 days" prompts.
- No upsells during use of the safety features.
- No data shared with any third party without per-transaction user authorization.
- No degradation of the free tier to drive hardware sales.
- No requirement of paid AI to use the system.
- No reliance on a single cloud provider for survival.

If any future decision conflicts with these, the decision loses. The principle document wins.

---

**End of Lite spec. Build: `BLACKBOX_SOFTWARE_SPEC.md`. Visual: `blackbox_mockup.html`. Foundation: `BLACK_BOX_PRINCIPLE.md`.**
