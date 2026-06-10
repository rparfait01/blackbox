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
| POST | `/v1/events/:id/close` | HMAC | Mark event closed (used by W6) |

**Auth:** every `/v1/events/:id/*` request is signed with the per-event
`hmacSecret` over `METHOD\npathname\ntimestamp\nsha256(body)` (see
`packages/shared/src/hmac.ts`), sent as `X-Event-Id` / `X-Timestamp` /
`X-Signature`. Timestamp skew tolerance is 5 minutes.

## Local development (no Cloudflare account needed)

`wrangler dev` runs against a local Miniflare simulation of D1 + R2.

```bash
# from workers/api
pnpm install                                   # at repo root
# apply the schema to the LOCAL D1
pnpm exec wrangler d1 execute blackbox --local --file=./migrations/0001_init.sql
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

No secrets are required for v0 — the per-event HMAC secret is generated
server-side and stored in D1. `.dev.vars` (gitignored) exists only for optional
local overrides; see `.dev.vars.example`.
