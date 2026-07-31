# BLACK BOX PWA (Stillpoint)

The user-facing Progressive Web App. One install, two faces: a **direct** mode
(BLACK BOX visible) and a **covert** mode (the Stillpoint meditation disguise),
chosen during onboarding and switchable in settings. Hosted on Cloudflare Pages.

## Build-time env

- `VITE_API_BASE_URL` — the deployed Worker origin. For **production and staging this
  comes from the tracked `config/deploy-targets.json`**, which `pnpm deploy` validates
  and passes into the build. For **local development only**, set it in `.env` (see
  `.env.example`); leaving it unset in a dev session means no backend, uploads off,
  capture local.
- `VITE_REVEAL_HOLD_MS` — optional override for the covert activation hold.

There are no `localhost` URLs in the bundle: the API base comes entirely from
`VITE_API_BASE_URL` at build time.

### A production build without an origin FAILS TO COMPILE (Brief 35 §A)

This used to be a warning-free fallback, and it was the worst bug in the product.
`API_BASE_URL` fell back to `''`, `uploadsEnabled` became false, and every consequence
was silent: activation still started local capture and still showed an active alert
while `registerUploadSession()`, the heartbeat, closure monitoring and every upload
returned early. **No event created. No contact notified. No evidence off the device.**
Because `.env` is gitignored and no tracked `apps/pwa/.env` exists, that is what any
clean clone or CI runner produced — and the deploy reported green, because the build ids
matched.

So a production build now refuses a missing, empty, non-HTTPS, or non-routable origin
with a non-zero exit and nothing published. Development keeps the permissive behaviour,
gated on Vite's `DEV`/mode flag — never on the variable being absent.

Deploy currency requires **three** conditions, not one:

1. the PWA and Worker build ids match (`scripts/assert-currency.mjs`);
2. the built artifact contains a valid HTTPS production API origin (checked in the
   bundle bytes by `scripts/deploy-pages.mjs`);
3. a canary round trip against that origin completes (`scripts/canary.mjs`).

Prove the failure paths without deploying: `node scripts/verify-hardening.mjs`.

## Develop

```bash
pnpm -F pwa dev          # vite dev server on http://localhost:5173
```

## Build + deploy to Cloudflare Pages

The Pages project is **blackbox-pwa** (`blackbox-pwa.pages.dev`).

```bash
pnpm -F pwa build                 # outputs to apps/pwa/dist
pnpm -F pwa deploy:pages          # wrangler pages deploy dist --project-name=blackbox-pwa
```

First deploy creates the project. After deploying, make sure the Worker's
`CORS_ALLOWED_ORIGINS` and `PWA_ORIGIN` (in `workers/api/wrangler.toml`) include
the Pages origin so sign-up, guardian-accept, and the magic-link dashboard work.

## Install to a phone

Open the Pages URL in Safari (iOS) or Chrome (Android) and choose **Add to Home
Screen**. The manifest is named "Stillpoint" so the home-screen icon reads as the
meditation app regardless of display mode.

## Routes

| Path | What |
| --- | --- |
| `/` | Root gate → onboarding (first launch), `/blackbox` (direct), or Stillpoint (covert) |
| `/onboarding` | 7-step sign-up + display-mode + codes + support contact |
| `/blackbox` | Direct-mode home (ARMED · LISTENING, tap to activate) |
| `/settings` | Profile, display-mode toggle, code changes, region, guardian, sign out |
| `/guardian-accept/:inviteId?t=…` | Guardian consent + email-OTP accept |

The contact's live dashboard is **not** a PWA route — it is served by the Worker
at `<worker-origin>/c/:id`.
