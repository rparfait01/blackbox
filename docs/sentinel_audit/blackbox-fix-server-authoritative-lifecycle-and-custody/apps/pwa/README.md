# BLACK BOX PWA (Stillpoint)

The user-facing Progressive Web App. One install, two faces: a **direct** mode
(BLACK BOX visible) and a **covert** mode (the Stillpoint meditation disguise),
chosen during onboarding and switchable in settings. Hosted on Cloudflare Pages.

## Build-time env

Set in `.env` (see `.env.example`):

- `VITE_API_BASE_URL` — the deployed Worker origin (e.g.
  `https://blackbox-api.<subdomain>.workers.dev`). **Required for sign-up,
  guardian invites, and uploads.** When unset the app stays fully local and auth
  calls fail — never ship a production build without it.
- `VITE_REVEAL_HOLD_MS` — optional override for the covert activation hold.

There are no `localhost` URLs in the bundle: the API base comes entirely from
`VITE_API_BASE_URL` at build time.

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
