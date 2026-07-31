# BRIEF 35 — DEPLOY GATE: NO BACKEND-DISABLED RELEASE

**Type:** FIX
**Priority:** P0 — RELEASE BLOCKER
**Floor:** current known-good. Zero regression to trigger (both modes), closure, check-in,
live-alert lock, §0a facade.
**Mode:** proven on deployed production. Proof is a build that fails and a canary that
completes — not "tests pass."
**Audit ref:** Pass 1 Finding 1 · Pass 2 Finding 1 (Confirmed — P0)

---

## CORRECTIONS

**BRIEF 021 §1 — corrected to read:**
"Deploy currency requires three conditions, all enforced before publish: the PWA and Worker
build IDs match; the built artifact contains a valid HTTPS production API origin; and a
canary round trip against that origin completes successfully. A build ID match alone does
not establish currency."
Path: `scripts/deploy.mjs`, `scripts/deploy-pages.mjs`, `apps/pwa/src/lib/env.ts`

**BRIEF 021 §1 — corrected to read:**
"A production build with no API origin is not a degraded build. It is a build in which the
alert path does not exist. It must fail to compile."
Path: `apps/pwa/src/lib/env.ts`

---

## THE DEFECT (settled — do not re-diagnose)

`API_BASE_URL` falls back to an empty string when `VITE_API_BASE_URL` is absent, and
`uploadsEnabled` becomes false. The deploy scripts never check it. `.env*` is gitignored and
there is no tracked `apps/pwa/.env`.

Consequence on a clean machine, a CI runner, or any environment missing the local env file:
activation still starts local capture, the UI shows an active alert, and
`registerUploadSession()`, heartbeat, closure monitoring, and every upload return early. **No
event is created. No contact is notified. No evidence leaves the device.** The currency check
passes because build IDs match.

This is the product's core promise failing silently, with a green deploy.

---

## §A — BUILD-TIME ASSERTION `[A]`

- In production mode, a missing, empty, non-HTTPS, or malformed `VITE_API_BASE_URL` **fails
  the build**. Not a warning. Not a fallback. A non-zero exit.
- Validate: non-empty, parses as a URL, scheme is `https:`, host is not `localhost` /
  `127.0.0.1` / a private range.
- Development mode keeps the current permissive behaviour, gated on an explicit dev flag —
  never on absence of the variable.
- Remove the empty-string fallback from `env.ts` entirely. There is no valid production
  state in which `API_BASE_URL` is empty, so the type should not permit it.

## §B — SUPPLY THE ORIGIN THROUGH DEPLOY CONFIG `[A]`

- The origin is supplied by the deploy pipeline, not by an untracked local file. A tracked,
  non-secret, per-environment config value.
- `.env` remains supported for local development only.
- The deploy script reads the value, validates it against §A's rules **before** invoking the
  build, and reports which origin it is building against.

## §C — CANARY ROUND TRIP `[A]`

The gate proves the built artifact can reach the intended Worker and complete a full
transaction. **It must not create a real emergency record or contact any real person.**

| Requirement | Implementation |
|---|---|
| Identity | A dedicated canary account, provisioned per environment. Never a real account. |
| Test marking | `isTest` is set **server-side**, derived from the canary account identity. It is never accepted from the client. A client-asserted test flag is rejected. |
| Dispatch | Suppressed at the notification router for test events. The delivery row records `suppressed_test` — never `sent`. No SMS, no email, no LINE, no push. |
| Payload | Synthetic fixed bytes. Never microphone or camera data. |
| Lifecycle | TTL expiry plus explicit purge at the end of the run. |
| Isolation | Canary events are excluded from activation counters, licence/coverage metrics, exports, dashboards, and vault sealing. |

**The gate fails the deploy if:** the origin is absent or invalid; the round trip does not
complete; a test event reaches a live dispatch path; or the purge does not confirm.

**The gate must not** print secret values. It verifies presence and shape of required
secrets and bindings, never their contents.

## §D — CLOSE THE GAP THIS BRIEF SURFACES `[A]`

Per `STANDING_CONSTRAINTS.md`, no loose ends. §C introduces a suppression path in the
notification router — a code path whose entire purpose is to not deliver. That path is a
safety hazard if it can ever be reached by a real event.

- Suppression keys **only** on the server-derived `isTest` flag.
- Add a regression check: a non-canary event with any client-supplied test marking dispatches
  normally.
- Log every suppression with the event ID and the reason. A suppression on a non-canary
  account is an alertable operator condition.

---

## ACCEPTANCE

Each proven on the deployed app, both Present modes, with captured evidence.

1. Unset the origin variable and run `pnpm deploy`. The build **fails** with a message naming
   the missing variable. Nothing is published.
2. Set the origin to `http://` and to a private host. Both fail.
3. Full deploy with a valid origin succeeds and reports the origin it built against.
4. The canary run creates an event on the canary account, records a `suppressed_test`
   delivery row, and purges. **Screenshot the delivery row.**
5. No real contact receives anything during the canary run. Confirm against the actual
   recipient inboxes and LINE.
6. Canary events do not appear in counters, exports, dashboards, or the vault.
7. A real trigger from a real account, both modes, still creates a live event and dispatches
   normally. **This is the regression that matters most.**
8. Full acceptance suite re-run, all prior greens still pass.

---

## THIS BRIEF DOES NOT CLOSE

- It does not make evidence confidential. Traffic reaching the server is not encrypted
  traffic. **Brief 36.**
- It does not fix silent local storage failure. **Brief 44.**
- It reduces reliance on local-only persistence; it does not eliminate it.
