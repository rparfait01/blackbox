# BLACK BOX API Worker

Cloudflare Worker (Hono) backing BLACK BOX: stores activation media in R2 and
metadata in D1. The Worker stores data only — it never analyzes it (classification
stays on-device) and never logs payload contents (only requestId / endpoint /
status / latency).

## Endpoints (`/v1`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | Liveness + D1/R2 binding check |
| POST | `/v1/events` | none | Create event, returns `{ eventId, hmacSecret }` |
| POST | `/v1/events/:id/chunks/:sequence` | HMAC | Upload one media chunk (raw bytes) |
| POST | `/v1/events/:id/locations` | HMAC | Append location points (batched) |
| POST | `/v1/events/:id/classifications` | HMAC | Append classification snapshots |
| POST | `/v1/events/:id/transcripts` | HMAC | Append transcript fragments |
| GET | `/v1/events/:id/delivery-status` | HMAC | Poll LINE delivery + closure state (drives closure teardown) |
| POST | `/v1/events/:id/close-request` | HMAC | User submitted a pin; route closure/duress message to contact |
| POST | `/v1/events/:id/close` | HMAC | Mark event closed |
| POST | `/v1/admin/contacts` | ADMIN_TOKEN | Upsert a contact + its endpoints for a userHash (pilot setup) |
| GET | `/v1/admin/contacts` | ADMIN_TOKEN | List contacts |
| GET | `/v1/admin/line-follows` | ADMIN_TOKEN | List LINE follow events (for pairing) |
| POST | `/v1/webhooks/line` | LINE signature | LINE follow + postback (approve/hold/duress-ack) events |
| GET | `/c/:id?t=token` | magic-link | **Contact dashboard HTML page** (no login; SSR location pin works without JS) |
| GET | `/v1/c/:id/state?t=token` | magic-link | Live state JSON (status, location+trail, classification, transcript, audio seq, emergency #) |
| GET | `/v1/c/:id/audio/latest?t=token` | magic-link | Latest audio chunk (LINE preview link) |
| GET | `/v1/c/:id/audio/:seq?t=token` | magic-link | One audio chunk by sequence (MSE progressive playback) |
| GET | `/v1/c/:id/audio/full?t=token` | magic-link | All chunks concatenated (no-MSE fallback player) |
| GET | `/v1/c/:id/audio/stream?t=token` | magic-link | SSE: new audio sequence numbers |
| GET | `/v1/c/:id/location/stream?t=token` | magic-link | SSE: new location fixes + trail |
| POST | `/v1/c/:id/responding?t=token` | magic-link | Records "I am responding" (no overt push to the user) |
| GET | `/v1/c/:id/share?t=token` | magic-link | Mints a fresh 1h dashboard link to forward to a second responder |
| POST | `/v1/c/:id/stand-down?t=token` | magic-link | Contact ends the alert (closes the event; routes a confirmation; no user push) |

**Auth:** every `/v1/events/:id/*` request is signed with the per-event
`hmacSecret` over `METHOD\npathname\ntimestamp\nsha256(body)` (see
`packages/shared/src/hmac.ts`), sent as `X-Event-Id` / `X-Timestamp` /
`X-Signature`. Timestamp skew tolerance is 5 minutes. Admin endpoints use a
`Bearer <ADMIN_TOKEN>` header. The contact view endpoints (`/v1/c/...`) are
authenticated solely by a stateless, HMAC-signed, 1-hour magic-link token — no
login, no database lookup.

## Contacts, channels, and the notification spine

**BLACK BOX is the system; LINE/SMS/email/push are channels.** A contact is a
PERSON (no app install, no account, not a user). Their reach methods live in
`contact_endpoints` — one or more rows of `(channel, channelIdentifier,
priority)`. The `NotificationRouter` tries them in priority order until one
accepts the message, so a contact without LINE is still reachable. Adding a
channel means implementing a `NotificationChannel` and registering it in the
router's factory — no schema change, no call-site change. v0 implements LINE;
`push`, `telegram`, `sms`, `email` are present as stubs that report "not
delivered" so the router falls through to the next endpoint. (`push` is the
highest-value channel to build next — it removes the third-party-app dependency.)

```
contacts(id, userHash, displayName, createdAt)
contact_endpoints(id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt)
```

**The acknowledgment loop:** user activates → cloud records → contact notified →
contact acknowledges (logged server-side) → contact responds externally to the
user, out of band. When `POST /v1/events` creates an event, the router pushes the
activation alert to the contact's best endpoint (retrying once after 5s); on
success it sets `events.notifiedAt` + `events.notifyChannel` and audits
`notification_delivered_<channel>` (or `notification_failed_<channel>` per
endpoint, `all_channels_failed` if none deliver). **There is no on-device
feedback to the user at any point** — BLACK BOX records and reaches, it does not
reassure (like an aircraft black box). The PWA polls `delivery-status` only to
detect a contact-initiated closure (pin-approval or stand-down).

**Contact-side messaging is loud, never covert.** The covert constraint protects
the user's phone (where an aggressor may be present); the contact is elsewhere.
Activation alerts and duress alerts are red and explicit. A **duress** closure
carries NO approve button — the user's duress pin already overrode approval, so
the contact is told to call emergency services directly and the recording
continues regardless of any response.

### Pilot pairing (LINE)

1. The contact adds the LINE Official Account as a friend → a `follow` event is
   recorded. Find their `channelUserId` via `GET /v1/admin/line-follows`.
2. Bind it to the user. New shape (preferred):
   ```
   POST /v1/admin/contacts
   { "userHash": "...", "displayName": "Royce",
     "endpoints": [{ "channel": "line", "channelIdentifier": "U...", "priority": 1 }] }
   ```
   The legacy shape `{ userHash, channel, channelUserId, displayName }` still
   works and is stored as a single endpoint at priority 1. `displayName` is the
   **user's** name (the alert subject, e.g. "Royce").
3. Set the LINE webhook URL in the LINE console to
   `https://<worker-origin>/v1/webhooks/line`.

## W7 — Contact dashboard

The Worker itself serves the contact's live dashboard at `GET /c/:id?t=<token>`
(the LINE "OPEN LIVE DASHBOARD" link points here). It is a self-contained HTML
page — inline CSS + JS, no third-party fonts or CDN scripts. The map uses
OpenStreetMap raster tiles rendered by a tiny self-written slippy map (no
Leaflet/Google CDN dependency). The location pin is server-side rendered so the
page is useful with JavaScript disabled; audio + live updates require JS.

- **Live audio:** progressive playback via MediaSource — the client fetches
  chunks in order (`/audio/:seq`) and appends them for gapless audio. Browsers
  without MSE (or webm/opus support, e.g. iOS Safari) fall back to the
  `/audio/full` concatenated stream. Autoplay is attempted; if blocked, a single
  tap-to-start button appears.
- **Live location / transcript / classification:** a 3s `/state` poll is the
  correctness backbone; the two SSE streams are a latency enhancement and the
  page degrades gracefully if they drop or are unsupported.
- **Actions:** I AM RESPONDING (records the response — no overt push to the
  user's covert phone), SHARE LIVE LINK (fresh token to clipboard), CALL
  EMERGENCY (`tel:` with the locale's number — Japan 110, from `events.locale`).
- **HOLD 3S TO STAND DOWN** (muted, deliberate 3s press-hold): the contact's
  path to end an alert without the user's pin — used when they know the user is
  safe through other means. `POST /v1/c/:id/stand-down` closes the event
  (`closedBy='contact_stand_down'`), audits `stand_down_by_contact`, and routes a
  confirmation to the contact. Nothing is pushed to the user; the PWA's closure
  monitor sees the closed status and tears down capture/upload/geolocation.
- Expired/invalid tokens render a friendly page (401), not a bare error.

## W8A — Identity, sign-up, guardians

The anonymous device UUID is no longer the account. A person signs up with a
**verified email** (OTP) + a **captured-but-unverified phone** (Twilio/SMS is
dropped from v0), chooses a **display mode** (direct / covert), and sets a
**lock code** (+ optional duress code). The account is a persistent `users` row
reached by an HMAC **session token** (no expiry in v0, sent as
`Authorization: Bearer`). Email OTP is delivered by SendGrid only.

Auth endpoints (`/v1/auth`): `signup/start` → `signup/verify-email` →
`signup/finalize` (issues the session token; `claimUserHash` links pre-existing
pilot rows), and `signin/start` → `signin/verify`. User/settings (`/v1/me`,
session-protected): profile, `display-mode`, `region`, `lock-code`,
`duress-code`. Guardian (`/v1/guardians`): `invite` (session), `GET /` status,
`resend`, `DELETE /`, and the public `accept/:id` → `accept/:id/otp` →
`accept/:id/verify` (the invite magic link is the auth; on verify the guardian's
email becomes a priority-1 endpoint on the user's contact).

`contacts` and `events` gained a nullable `userId`. The router resolves a
contact for an event by `userId` first, then legacy `userHash`, so pilot data and
new accounts coexist.

## Required secrets (`wrangler secret put`)

Never put these in `wrangler.toml` or source.

| Secret | Purpose |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | Long-lived Bearer token for the LINE push API |
| `LINE_CHANNEL_SECRET` | Verifies inbound LINE webhook signatures (HMAC-SHA256) |
| `ADMIN_TOKEN` | Bearer token protecting the pilot-only `/v1/admin/*` endpoints |
| `MAGIC_LINK_SECRET` | HMAC key signing read-only contact magic-link tokens |
| `SESSION_SECRET` | HMAC key signing user session + guardian-invite tokens (falls back to `MAGIC_LINK_SECRET`) |
| `SENDGRID_API_KEY` | SendGrid v3 API key (email channel + OTP/invite mail) |
| `SENDGRID_FROM_EMAIL` | Verified SendGrid sender address |
| `SENDGRID_FROM_NAME` | Sender display name (optional; default "BLACK BOX") |

```bash
pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
pnpm exec wrangler secret put LINE_CHANNEL_SECRET
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put MAGIC_LINK_SECRET
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put SENDGRID_API_KEY
pnpm exec wrangler secret put SENDGRID_FROM_EMAIL
pnpm exec wrangler secret put SENDGRID_FROM_NAME
```

Also set `PWA_ORIGIN` in `wrangler.toml [vars]` to the deployed Pages URL so the
contact's dashboard link resolves to the PWA.

## Local development (no Cloudflare account needed)

`wrangler dev` runs against a local Miniflare simulation of D1 + R2.

```bash
# from workers/api
pnpm install                                   # at repo root
# apply all migrations to the LOCAL D1
pnpm exec wrangler d1 migrations apply blackbox --local
# run the worker locally on http://localhost:8787
pnpm exec wrangler dev --local --port 8787
```

Point the PWA at it with `VITE_API_BASE_URL=http://localhost:8787` (see
`apps/pwa/.env.example`).

## Production deploy (your Cloudflare account)

```bash
# 1. Create the D1 database and paste the returned database_id into wrangler.toml
pnpm exec wrangler d1 create blackbox

# 2. Create the R2 bucket (requires R2 enabled on the account)
pnpm exec wrangler r2 bucket create blackbox-media

# 3. Apply migrations to the remote D1
pnpm exec wrangler d1 migrations apply blackbox --remote

# 4. Set CORS_ALLOWED_ORIGINS for your deployed PWA origin in wrangler.toml [vars]

# 5. Deploy
pnpm exec wrangler deploy
```

The per-event HMAC secret is generated server-side and stored in D1. The W6
secrets above are required for LINE delivery, admin setup, and magic-link views;
when they are unset the Worker degrades gracefully (notifications are audited as
`notification_skipped` and the app keeps recording locally). `.dev.vars`
(gitignored) holds them for local dev; see `.dev.vars.example`.

## The deploy canary (Brief 35 §C)

`pnpm deploy` finishes by proving the alert path EXISTS on the origin it just published —
build ids matching only proves both halves came from one commit, not that the client can
reach the server. `scripts/canary.mjs` opens a real event through the ordinary
authenticated trigger path, uploads a synthetic chunk, beats a heartbeat, reads the
delivery log back, and purges.

Three admin routes support it (`ADMIN_TOKEN` or an operator session, like every
`/v1/admin/*` route):

| Route | Does |
|---|---|
| `POST /v1/admin/canary/provision` | Idempotently ensure this environment's canary account (`canary@blackbox.test`) + its reserved-address contact, and mint a session for it. The **only** writer of `users.isCanary`. |
| `GET /v1/admin/canary/status` | Presence-and-shape of required bindings and secrets. Never returns a secret's value. |
| `POST /v1/admin/canary/purge` | Delete every canary event, its R2 objects and every row keyed to them. Returns `remaining`, which the gate requires to be 0. |

**Nothing is dispatched.** `events.isTest` is derived server-side at creation from the
account (a client cannot assert it), and the notification router withholds the dispatch —
recording `suppressed_test`, never `sent`. The canary's own addresses are RFC 2606
reserved on top of that, so even total failure of the flag reaches nobody.

The suppression predicate requires the flag **and** a still-canary owner, both re-derived
at dispatch time. A flag found on a real account **dispatches normally** and raises an
alertable operator condition (`canary_flag_on_non_canary_account`) — the failure costs a
test run, never a life. Pinned by `test/canary-severance.guard.test.ts` and acceptance
checks 82–83.

A run that dies mid-way is cleaned up by the cron TTL sweep (15 minutes).
