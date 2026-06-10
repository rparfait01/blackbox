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

The PWA opens to **Stillpoint**, a meditation facade. A deliberate press-and-hold
gesture on the breathing circle reveals the real BLACK BOX dashboard. This is by
design — the safety interface stays hidden until the user reveals it.

## Status: W1 — Foundation

This repository is at build phase **W1 (Foundation)**. What works today:

- The Stillpoint meditation home with a functional reveal gesture.
- The BLACK BOX dashboard (dormant state) revealed via the gesture, with a 60-second
  inactivity auto-return to the facade.
- Placeholder routes for settings, onboarding, and history.
- PWA shell: web manifest, service worker, placeholder icons.
- Worker scaffold with a `/health` endpoint (not deployed).

Capture, recording, notifications, and backend logic arrive in later phases (W2+).

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

### Dev reveal gesture

In production the reveal gesture requires a **5-second** hold on the breathing circle.
During development it is shortened to **1.5 seconds** for easier testing. Override it
with `VITE_REVEAL_HOLD_MS` in `apps/pwa/.env` (see `apps/pwa/.env.example`).

## Contributing

BLACK BOX is open-source so that the protection survives the company. Contributions are
welcome, with a few non-negotiables drawn from the principle:

- **No analytics, telemetry, tracking, or third-party usage metrics.** Ever.
- **No feature behind a recurring fee.** If a feature needs ongoing cost, absorb it or
  don't ship it.
- **No fear-based or engagement-driven patterns.** No retention loops, no upsells.
- TypeScript strict mode everywhere. No `any` without a commented justification.
- Files are kebab-case; React component files are PascalCase.
- The meditation facade and the BLACK BOX views stay dependency-separate — they share
  only design tokens.

Before opening a PR, run `pnpm lint`, `pnpm typecheck`, and `pnpm format`.

This project is built with particular care for survivors of abuse. Features that affect
safety are reviewed against the principle and, where relevant, with domestic-violence
organizations.

## License

[GNU Affero General Public License v3.0 or later](LICENSE). The hardware is patented
defensively — to prevent others from enclosing what is meant to be free.
