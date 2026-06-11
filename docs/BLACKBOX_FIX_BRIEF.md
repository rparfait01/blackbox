# BLACK BOX — Comprehensive Fix Brief

Work order for Claude Code. Stack: PWA client + Cloudflare Workers + D1 + R2,
deployed via wrangler. SendGrid for email.

**Rules of engagement:**
- Work in priority order (P0 → P2). Do not skip ahead.
- For each item: run the DIAGNOSE step and report findings **before** applying the FIX.
- After all fixes, run the ACCEPTANCE CRITERIA at the bottom and confirm each passes.
- Make the app a proper installable standalone PWA as part of P2 (#10), but do not
  rely on install for alert durability — that comes from the server model in #3.

---

## P0 — CRITICAL (an alert can currently fail silently)

### #3 — Alert must survive any client disruption (server-authoritative lifecycle)

DIAGNOSE
1. Trace activation in the client. Does it POST to the Worker first, or start
   recording / other work first? Report the exact order.
2. Find the Worker route receiving activation. Does it create the event and send
   notifications synchronously on receipt, or wait for a media upload?
3. Find EVERY path that closes or cancels an event. Check for closes triggered by
   `beforeunload`, `pagehide`, `visibilitychange`, route changes, or a missing
   heartbeat. List each one.

FIX
- On activate, the client's FIRST action is `POST /api/alert/open`
  `{userId, timestamp, location, sessionId}`. Nothing else runs first.
- Worker `/api/alert/open`: write event to D1 with `status=active`, then IMMEDIATELY
  dispatch all notification channels. Do NOT gate notifications on any media upload.
  Return fast.
- Decouple media: client streams audio/location chunks to `/api/alert/:id/chunk`
  opportunistically. If the page dies, chunks stop but the event stays active.
- Cancellation: ONLY an authenticated `POST /api/alert/:id/standdown` carrying the
  verified lock code closes an event. Remove every implicit close (unload /
  visibilitychange / route change).
- Heartbeat: client pings `/api/alert/:id/heartbeat` every 10s. Worker MUST NOT
  auto-close on a missed heartbeat. After activation, a missed heartbeat fires an
  escalation notification ("device went dark") — interruption escalates, never cancels.
- Use `navigator.sendBeacon` on `pagehide` to mark the client "lost," not "cancelled."

### #5 — Notifications are not being delivered (Ikumi gets nothing)

DIAGNOSE
1. Pull Worker logs (`wrangler tail`) during a live activation. Is the send even firing?
2. Open the SendGrid Activity Feed. Is the message delivered / blocked / bounced / spam?
3. Check sender authentication: is the from-address a verified sender, with SPF + DKIM
   (domain authentication) configured? Unauthenticated senders get silently dropped.
4. Confirm the API key is valid and not rate-limited.

FIX
- Move notification dispatch server-side, fired on `/api/alert/open` (ties to #3).
- Authenticate the sending domain in SendGrid (SPF/DKIM) or use a verified single sender.
- Write a per-channel delivery record to D1 for every alert (`channel`, `status`,
  `provider_message_id`, `timestamp`) so delivery is observable, not guessed.
- If a channel fails, log it and surface it; do not fail silently.

### #4 — Lock screen only accepts 3 of 4 digits (user cannot cancel an alert)

DIAGNOSE
- Find the PIN input handler. Is the digit appended BEFORE or AFTER the length check?
- Confirm the configured code length (4) matches the UI dot count (4).

FIX
- Append the digit FIRST, THEN check `if (code.length === 4) validate()`. Order bug.
- Ensure the 4th keypress registers before any submit fires.

---

## P1 — ACTIVATION RELIABILITY

### #1 — Hold-to-activate is too long (5s → 1.5–2s)

DIAGNOSE
- Find the activation hold timer (likely a `setTimeout(..., 5000)` or press-duration check).

FIX
- Set threshold to 1500–2000ms.
- Add a filling progress ring during the hold so it stays deliberate and feels responsive.

### #9 — Holding the activate control selects text instead of triggering

DIAGNOSE
- Confirm the activate control / label is selectable text (blue selection handles appear).

FIX
- Add to the control and its label:
  `user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; touch-action:manipulation;`
- Drive the hold timer from `touchstart` / `touchend` (and pointer events) with
  `preventDefault()`, not a long-press the OS interprets as selection.
- Make the control a non-text element (div/button), not raw selectable text.

### #6 — Camera not activating

DIAGNOSE
- Inspect the `getUserMedia` constraints. Does it request `{ audio: true, video: true }`
  or audio only?
- Is there a `<video playsinline muted>` sink in the DOM with `.play()` called from the gesture?
- Confirm intended behavior: covert (Stillpoint) mode should likely keep the camera OFF;
  overt mode should activate it.

FIX
- Request video in the constraints when in overt mode / when a camera source is selected.
- Mount a `<video playsinline muted>` element and call `.play()` from the activation gesture.
- Handle absence of a camera gracefully (fall back to audio + location).

### #7 / #8 — Microphone and location re-prompt every time

DIAGNOSE
1. Detect standalone PWA vs browser tab (`window.matchMedia('(display-mode: standalone)')`).
   iOS browser tabs re-prompt every session by design.
2. Find every `getUserMedia` and `geolocation` call. Requested fresh per activation, or once and reused?

FIX
- Request mic + location during ONBOARDING via a user gesture — never at activation time.
  A permission dialog must never appear mid-alert.
- Location: start `navigator.geolocation.watchPosition` when armed and keep it running;
  do not call `getCurrentPosition` per event.
- Keep the granted `MediaStream` reference alive while armed instead of re-acquiring.
- Flag clearly: iOS re-prompts web camera/mic aggressively even when installed. Full
  persistence requires the Capacitor native shell (v1) — note which of these will only
  be fully resolved there.

---

## P2 — INSTALL & SHELL RESILIENCE

### #10 — No way to install / download on the phone

DIAGNOSE
- Confirm the browser in use is Safari (only Safari can Add to Home Screen on iOS;
  the toolbar in the user's screenshots does not look like Safari).
- Validate `manifest.json`: `name`, `short_name`, `start_url`, `scope`,
  `display: "standalone"`, `theme_color`, `background_color`, and icons (192 + 512,
  including a maskable icon).
- Confirm a service worker is registered and the site is served over HTTPS (pages.dev is).

FIX
- Repair `manifest.json` and add `apple-touch-icon` + `apple-mobile-web-app-capable` meta tags.
- Add an onboarding step that walks the user through Add to Home Screen in Safari (iOS),
  since iOS gives no automatic prompt.
- On Android, wire `beforeinstallprompt` to a visible Install button.

### #2 — No back button from Settings

DIAGNOSE
- Confirm the settings view has no dismiss affordance.

FIX
- Add a back/close control that returns to the main armed screen.

---

## CEILING (do not attempt to fix here)

After the above: the alert is durable (survives app death), reachable (notifications
fire server-side and are observable), and the phone going dark escalates rather than
cancels. The remaining gap — continuous audio/video capture while the phone is locked
or backgrounded — is an iOS limitation that install does NOT fix and the server model
does NOT need. That is the dedicated job of the Capacitor native shell (v1). Leave it.

---

## ACCEPTANCE CRITERIA (run after all fixes)

1. Activate, then immediately lock the phone. Within ~5s, the primary contact receives
   the alert email, and the event shows `status=active` server-side. (#3, #5)
2. Activate, then force-quit the app entirely. The event remains `active` server-side and
   a "device went dark" escalation fires. (#3)
3. Enter a 4-digit lock code on the cancel screen. The 4th digit registers and cancellation
   succeeds. No other path closes an event. (#4)
4. Hold to activate completes in 1.5–2s with a visible progress ring. (#1)
5. Holding the activate control never selects text. (#9)
6. In overt mode, activation starts the camera; in covert mode it does not. (#6)
7. After onboarding, activation does not prompt for mic or location. (#7, #8)
8. The app installs to the home screen and launches in standalone mode with no browser
   chrome (no back button). (#10)
9. Settings can be dismissed back to the armed screen. (#2)
10. SendGrid Activity Feed shows `delivered` for the test alert, and D1 has a per-channel
    delivery record. (#5)
