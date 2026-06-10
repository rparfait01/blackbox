# BLACK BOX — PWA Interface Specification

**Version:** 1.0
**Status:** Implementation-ready
**Companion file:** `blackbox_mockup.html` (live interactive preview)

---

## 1. Design thesis

The PWA is an **instrument**, not an app.

The user's relationship to BLACK BOX is mostly passive. They check it occasionally to confirm it's armed. They never *want* to use the active mode. When they do, they're not reading carefully — they're running, hiding, or fighting. The interface has to work for both: trust at a glance when dormant, signal-without-screaming when active.

Visual reference vocabulary: aviation instruments, marine EPIRB, military survival gear, flight recorder. Not gadget. Not gamer. Not consumer-cute.

**The single voice the interface speaks:**
> ARMED · LISTENING
> RECORDING · NOTIFIED · TRACKING
> CANCELLED · STANDING DOWN

Mono-spaced, capital, deliberate spacing. The system says what it's doing, exactly, in the same terms every time.

---

## 2. Design tokens

### Color

The palette is almost entirely greys against true black, with **one** semantic color visible at a time:

| Token | Hex | Use |
|---|---|---|
| `bg-primary` | `#000000` | Screen background |
| `bg-surface` | `#0F0F0F` | Panels, cards |
| `bg-elevated` | `#1A1A1A` | Modals, sheets |
| `border-subtle` | `#222222` | Hairline dividers |
| `border-defined` | `#333333` | Card edges |
| `text-primary` | `#E8E8E8` | Body text (warm off-white) |
| `text-secondary` | `#888888` | Labels, metadata |
| `text-tertiary` | `#555555` | Inactive, placeholders |
| `status-armed` | `#E89A00` | Dormant-armed indicator (muted amber, not screaming) |
| `status-active` | `#FF3B30` | Emergency in progress |
| `status-ack` | `#34C759` | Acknowledgment received |

Only **one** status color is visible at a time. When dormant: amber. When active: red. Never both.

### Typography

Three faces, all from the IBM Plex family (free, Google Fonts, designed for technical interfaces):

- **Display:** IBM Plex Sans Condensed — weights 500, 600, 700
- **Body:** IBM Plex Sans — weights 400, 500, 600
- **Mono:** IBM Plex Mono — weights 400, 500, 700

The Mono face does the heavy lifting on identity. All system-voice messages, all data (coordinates, time, battery, percentages), all status labels use Mono. This is what makes it read as an instrument.

### Type scale (mobile-first)

| Token | Size / Line / Tracking | Use |
|---|---|---|
| `display-xl` | 32 / 36 / -0.02em | Active state hero (time elapsed) |
| `display-l` | 24 / 28 / -0.01em | Section heroes |
| `body-l` | 17 / 24 / 0 | Primary reading |
| `body-m` | 15 / 22 / 0 | Standard body |
| `caption` | 13 / 18 / 0 | Metadata |
| `micro` | 11 / 14 / 0.06em / UPPERCASE | Status labels, system voice |

### Spacing (4px base)

`xs: 4 · sm: 8 · md: 16 · lg: 24 · xl: 32 · 2xl: 48 · 3xl: 64`

### Border radius

Mostly **0px**. Cards and buttons: 4px. The signature element (status disc) is circular.

### Motion

- **Dormant pulse:** 3s ease-in-out, opacity 0.6 → 1.0 → 0.6 on the status disc. Slow, calm.
- **Active pulse:** 1.2s ease-out, sonar rings expanding outward at staggered 400ms intervals. Urgent but not frantic.
- **State transition (dormant → active):** 300ms. The center disc bursts into the first sonar ring, color shifts amber → red.
- **Reduced motion preference:** respect `prefers-reduced-motion`, replace pulses with static rings.

---

## 3. The signature element

A **circular status disc**, ~120px diameter on mobile, centered vertically in the dormant view. It is the single piece of the interface that carries identity.

**Dormant:** Dark disc with a thin amber inner ring. Gentle, slow pulse on the ring. Inside the disc, an extremely small `●` glyph in amber. The disc reads as a small, alive instrument — confirming life without demanding attention.

**Active:** The disc transforms. Sonar rings expand outward from it at intervals. Red. Inside the disc: a single `◉` glyph. Below it, the elapsed time in Mono, large, counting up.

Everything else on the screen — typography, layout, status text — supports this central element.

---

## 4. Dormant state

The home screen when the system is armed and waiting.

### Wireframe (mobile, 380px viewport)

```
┌─────────────────────────────────────┐
│                                     │  16
│  BLACK BOX            SETTINGS      │   ← Top bar: wordmark + gear
│                                     │  16
├─────────────────────────────────────┤
│                                     │  48
│         ARMED · LISTENING           │   ← System voice line (Mono, micro, amber)
│                                     │  48
│           ╭──────────╮              │
│          │            │             │
│          │     ●      │             │   ← Status disc, ~120px, slow amber pulse
│          │            │             │
│           ╰──────────╯              │
│                                     │  32
│         TAP TO ACTIVATE             │   ← Single primary action (Mono, micro, dim)
│                                     │  48
├─────────────────────────────────────┤
│  DEVICE                             │   ← Section label (Mono, micro, secondary)
│  Black Box 001       BAT 84%        │
│  Paired · Last seen 12s ago         │
├─────────────────────────────────────┤
│  PRIMARY CONTACT                    │
│  Ava Tanaka                         │
│  Telegram · Verified · Online       │
├─────────────────────────────────────┤
│  AI                                 │
│  Anthropic · Claude Sonnet 4.5      │
│  Key valid · 12,847 tokens left     │
├─────────────────────────────────────┤
│  LAST ACTIVITY                      │
│  Self-test passed · 06:32 JST       │
│                                     │
└─────────────────────────────────────┘
```

### Behavior

- **Tap to activate:** entire central disc area is tappable. Single tap shows confirmation sheet (sliding up from bottom): "ACTIVATE BLACK BOX — Hold to confirm." Holding the button for 800ms commits.
- **Practice mode toggle:** in Settings. When on, "TAP TO ACTIVATE" reads "TAP FOR PRACTICE" and activation runs full pipeline but with `[TEST]` tag on all notifications.
- **Pull-to-refresh:** triggers a self-test (re-pings device, validates AI key, confirms contacts).
- **No bottom navigation bar.** This is not a multi-section app. One screen, one job.

### Status disc behavior matrix

| System state | Disc fill | Ring color | Animation |
|---|---|---|---|
| Armed, all systems verified | Dark | Amber | Slow pulse 3s |
| Armed, device disconnected | Dark | Amber | Slow pulse 3s + small "!" badge |
| Armed, AI provider error | Dark | Amber | Slow pulse 3s + small "AI" badge |
| Disarmed (manually paused) | Dark | Grey | No pulse |
| Activating (in 800ms hold) | Filling | Amber → Red | Color shift |
| Active emergency | Red center | Red | Sonar rings expanding |

---

## 5. Active state

The screen during an active emergency.

### Wireframe (mobile, 380px viewport)

```
┌─────────────────────────────────────┐
│                                     │
│  ◉ RECORDING         04:32          │   ← Top bar: state + elapsed (Mono)
│                                     │
├─────────────────────────────────────┤
│                                     │
│          ╭ ─ ─ ─ ─ ╮                │
│         ╱           ╲               │
│        │      ◉      │              │   ← Disc with expanding red sonar rings
│         ╲           ╱               │
│          ╰ ─ ─ ─ ─ ╯                │
│                                     │
│        TRACKING · NOTIFIED          │   ← Active system voice (Mono, micro, red)
│                                     │
├─────────────────────────────────────┤
│  LOCATION                           │
│  26.3344°N  127.7894°E              │   ← Mono coordinates, large
│  ±4m · MOVING NORTH · 1.2 m/s       │
├─────────────────────────────────────┤
│  LIVE TRANSCRIPT                    │
│                                     │
│  "Please don't, I'll do whatever    │
│   you want, please just—"           │   ← Latest segment (body L, primary)
│                                     │
│  ─ I told you to shut up ─          │   ← Aggressor segment (mono, italic)
│                                     │
│  Voice 1 · 0:23                     │
│  Voice 2 · 0:14                     │
├─────────────────────────────────────┤
│  CLASSIFICATION                     │
│                                     │
│  Two voices · One aggressor         │
│  Compliance language detected       │   ← AI-generated, plain language
│  Threat assessment: HIGH            │
├─────────────────────────────────────┤
│  NOTIFIED                           │
│                                     │
│  ● Ava Tanaka       Responding      │   ← Green dot for ack, red for sent
│  ● Sarah Chen       Reached         │
│  ○ Mom              Pending         │
│                                     │
│  Dashboard live · 2 viewers         │
├─────────────────────────────────────┤
│                                     │
│  ╔═══════════════════════════════╗  │
│  ║  HOLD 3s TO CANCEL            ║  │   ← Hard to fat-finger
│  ╚═══════════════════════════════╝  │
│                                     │
└─────────────────────────────────────┘
```

### Behavior

- **Always-on screen** while active. Wake lock requested.
- **No accidental dismiss.** Back button, swipe-back, app-switcher all suppressed when possible.
- **Cancel requires 3-second hold** with visible progress fill on the button. Releasing early aborts the cancel.
- **Duress phrase:** if user speaks the configured duress phrase, screen *appears* to cancel (returns to dormant) but recording and transmission continue silently. Contact notification gets `[DURESS]` tag and updated severity.
- **Battery saver:** screen dims after 30s of no interaction; tap to wake. Recording and transmission continue regardless of screen state.

### Decoy mode (optional, configurable)

If user enables decoy mode in settings, active screen renders as either:
- **Calculator:** simple working calculator UI. Hidden hold-gesture (e.g., long-press the `=` key) reveals the real active screen.
- **Notes:** a fake notes app. Same hidden-gesture pattern.

Recording continues underneath. This is the version the user shows if an aggressor demands to see their phone.

Decoy mode is OFF by default. The user must deliberately enable it and acknowledge that they understand cancel is harder to access.

---

## 6. Notification + lock screen design

### Lock screen (active)

Single notification, minimal text:

```
┌───────────────────────────────────┐
│ BLACK BOX                  4:32   │
│ ───────────────────────────────── │
│ Active · Tap to view              │
└───────────────────────────────────┘
```

No transcript preview, no location, nothing that would tip off an observer glancing at the phone. The user (or trusted person) taps the notification to see the full active screen.

### Lock screen (contact acknowledgment)

```
┌───────────────────────────────────┐
│ BLACK BOX                         │
│ ───────────────────────────────── │
│ Ava is responding                 │
└───────────────────────────────────┘
```

Discrete confirmation. Haptic ping.

### Pull-down expanded view

Expanded notification reveals:
- Elapsed time
- Hold-to-cancel button (3s, same as in-app)
- "Open" to full view

---

## 7. Onboarding flow

Five screens. Total target completion time: under 5 minutes.

```
[1] WELCOME            → What BLACK BOX is, what it's not
[2] CONTACTS           → Add 1-3 emergency contacts via Telegram link
[3] AI PROVIDER        → BYOK setup OR free tier OR skip (local-only)
[4] TRIGGERS           → Configure shake sensitivity, voice phrase, etc
[5] PRACTICE           → Run a live practice activation, see the flow
```

### Tone of voice in onboarding

Direct, plain, no marketing. From the first screen:

> BLACK BOX is a personal safety system. When activated, it records audio and your location, and notifies your emergency contacts.
>
> It is interruption-resistant, not indestructible. If someone tries to break it, the break itself becomes the signal.
>
> Set it up once. Carry it. Hope you never need it.

No emojis, no exclamation marks, no soft language.

---

## 8. Settings (secondary screen)

Single scrolling list. Sections:

```
PROFILE
  Display name
  Voice profile (for diarization)

EMERGENCY CONTACTS
  Manage primary, secondary, tertiary
  Test ping each channel

AI PROVIDER
  Switch provider
  Update key
  Toggle local-only mode (no AI)

TRIGGERS
  Manual button (always on)
  Shake — sensitivity slider
  Voice keyword — phrase setting
  BLE device — pair / unpair
  Check-in timer

PHRASES
  Cancel phrase — set
  Duress phrase — set

ACTIVE-MODE APPEARANCE
  Standard
  Decoy: Calculator
  Decoy: Notes

NOTIFICATIONS
  Channels priority
  Cascade timing
  SMS fallback (paid)

DATA
  Retention period
  Export history
  Wipe all data

ABOUT
  Version
  Privacy policy
  Terms
  Open source licenses
```

No marketing, no upsells, no "Pro" badges. Settings is a list of facts and switches.

---

## 9. Writing principles

Every word in the interface follows these rules:

- **Active voice. Exact action.** "Save changes," not "Submit." "Cancel emergency," not "Stop."
- **Same word, same flow.** The button says "Activate" → the toast says "Activated" → the history row says "Activation."
- **No apologies.** Errors say what failed and what to do. They do not say "Oops" or "Sorry."
- **No empty mood.** Empty states give the next action. "No activations yet. Run a practice to test the system."
- **System voice is Mono and capital.** User voice (in transcript playback) is body and sentence case. Clear distinction.

Sample copy contrast:

| Don't | Do |
|---|---|
| Oops! Something went wrong 😕 | AI provider unreachable. Recording continues locally. |
| Are you sure you want to cancel? | HOLD 3s TO CANCEL |
| Welcome to BLACK BOX! 🚀 | BLACK BOX is a personal safety system. |
| You haven't added contacts yet | Add an emergency contact to arm the system. |

---

## 10. Accessibility floor

- **Contrast:** All text against `bg-primary` meets WCAG AAA (#E8E8E8 on #000000 = 17.4:1).
- **Hit targets:** Minimum 44×44pt for all interactive elements. Cancel button is larger (entire bottom band).
- **Reduced motion:** Pulses and sonar rings replaced with static rings. State changes use crossfade instead of bursts.
- **Voice control:** All primary actions have voice-control labels.
- **Screen reader:** Status disc has `aria-live="polite"` for state changes; active screen uses `aria-live="assertive"` for critical updates only (new contact ack, threat level change, cancel).
- **Color independence:** All status conveyed by color is also conveyed by text and/or shape.

---

## 11. Implementation notes for Claude Code

When building this:

1. Start with the design tokens as a Tailwind config extension and CSS custom properties. Both. Tailwind for components, CSS vars for the few places we need runtime theming (state-based color shift).
2. Use shadcn/ui as the component primitive base, but **override the defaults aggressively** — shadcn's defaults are intentionally generic. We want the IBM Plex faces, sharp corners, instrument feel.
3. Don't use Material icons or Heroicons. Use **Phosphor Icons** (`phosphor-react`) — their thin/light/bold weights match the instrument aesthetic.
4. The status disc is a single React component with state-driven props (`armed | activating | active | error | disarmed`). All transitions happen inside that component.
5. Active screen runs in its own route with `<WakeLock>` request and aggressive history-stack manipulation to prevent accidental back-navigation.
6. Mono font is critical for identity. If IBM Plex Mono isn't available (offline), fall back to `ui-monospace, "SF Mono", "Cascadia Mono", monospace` — never Courier.

---

**End of interface spec. See `blackbox_mockup.html` for the live visual.**
