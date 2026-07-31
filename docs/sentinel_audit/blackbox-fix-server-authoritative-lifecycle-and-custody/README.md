# BLACK BOX

**A personal safety system for people who cannot afford to be safe.**

BLACK BOX is a personal safety system: a wearable hardware trigger paired with a
Progressive Web App that, on activation, records audio/video/location locally,
streams to a live dashboard, and notifies emergency contacts via free messaging
channels. The user brings their own AI key (BYOK) for situational classification
— no recurring fees, no vendor lock-in.

> BLACK BOX is not indestructible. It is interruption-resistant.
> If someone tries to break it, the break becomes the signal.

## The principle

This project is governed by [`docs/BLACK_BOX_PRINCIPLE.md`](docs/BLACK_BOX_PRINCIPLE.md).
Every engineering decision is checked against it. In short:

- **Single sale.** Pay once. Own forever. No feature ever moves behind a recurring fee.
- **Humanized thought.** Every decision begins by picturing a scared person at 2 a.m.
  and asking what would _help_ them.
- **Not surveillance.** No analytics, no telemetry, no tracking, no third-party usage
  metrics. The user owns their data and their keys.
- **Not engagement-optimized.** No retention loops. It works the night you need it and
  stays invisible otherwise.
- **Not closed.** The software is open-source under AGPL-3.0. Anyone can audit, fork, or
  self-host it.

If a decision cannot be reconciled with the principle, the principle wins.

## Architecture (v0 pilot)

A pnpm monorepo:

| Workspace          | What it is                                                            |
| ------------------ | -------------------------------------------------------------------- |
| `apps/pwa`         | The user-facing PWA (Vite + React + TypeScript + Tailwind + shadcn). |
| `workers/api`      | Cloudflare Worker API (Hono). Scaffold only in W1.                   |
| `packages/shared`  | Cross-package TypeScript types and Zod schemas.                      |

**Stillpoint is the entire visible surface of the app.** There is no dashboard, no
armed view, and no BLACK BOX wordmark anywhere the user can see. From install to use
to closure, the only visible app is a meditation app. Activation is covert: a deliberate
press-and-hold on the breathing circle is a trigger that produces no visible output —
the meditation view simply continues. (Voice phrase and hardware-button triggers arrive
in a later phase.)

## Status: W1 — Foundation

This repository is at build phase **W1 (Foundation)**. What works today:

- The Stillpoint meditation home: hue-drifting gradient, three breathing circles,
  serif wordmark, and a counting-up session timer.
- The covert press-and-hold activation trigger on the breathing circle, with a progress
  ring. On completion it fires a development-only log and produces no visible output —
  and there is no on-device feedback at any point in a session (the system records and
  reaches, it does not reassure).
- An empty `/settings` route reserved for a later phase (nothing links to it yet).
- PWA shell: web manifest (named "Stillpoint"), service worker, placeholder icons.
- Worker scaffold with a `/health` endpoint (not deployed).

Capture, recording, notifications, triggers, and backend logic arrive in later phases (W2+).

## Prerequisites

- **Node.js** ≥ 20 (developed on Node 24)
- **pnpm** ≥ 9 — install with `npm install -g pnpm` or `corepack enable`
- **Git**

## Setup (Windows)

These commands work in PowerShell or any terminal. Paths use the repo root.

```powershell
# 1. Install dependencies for every workspace
pnpm install

# 2. Start the PWA dev server (Vite, default port 5173)
pnpm -F pwa dev
# Open http://localhost:5173

# 3. Produce a production build of the PWA
pnpm -F pwa build
# Output lands in apps/pwa/dist
```

### Useful scripts

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `pnpm dev`            | Start the PWA dev server.                     |
| `pnpm build`          | Production build of the PWA.                  |
| `pnpm lint`           | ESLint across all workspaces.                 |
| `pnpm format`         | Prettier write across the repo.               |
| `pnpm typecheck`      | TypeScript typecheck across all workspaces.   |

### Dev activation hold

In production the activation trigger requires a **5-second** hold on the breathing
circle. During development it is shortened to **1.5 seconds** for easier testing.
Override it with `VITE_REVEAL_HOLD_MS` in `apps/pwa/.env` (see `apps/pwa/.env.example`).
In W1 the completed hold only logs `trigger: stillpoint-press` to the console for
verification — there is no visible effect by design.

## Contributing

BLACK BOX is open-source so that the protection survives the company. Contributions are
welcome, with a few non-negotiables drawn from the principle:

- **No analytics, telemetry, tracking, or third-party usage metrics.** Ever.
- **No feature behind a recurring fee.** If a feature needs ongoing cost, absorb it or
  don't ship it.
- **No fear-based or engagement-driven patterns.** No retention loops, no upsells.
- TypeScript strict mode everywhere. No `any` without a commented justification.
- Files are kebab-case; React component files are PascalCase.
- The visible surface is Stillpoint only — no safety, emergency, or BLACK BOX language
  appears anywhere the user can see during normal use.

Before opening a PR, run `pnpm lint`, `pnpm typecheck`, and `pnpm format`.

This project is built with particular care for survivors of abuse. Features that affect
safety are reviewed against the principle and, where relevant, with domestic-violence
organizations.

## License

[GNU Affero General Public License v3.0 or later](LICENSE). The hardware is patented
defensively — to prevent others from enclosing what is meant to be free.
