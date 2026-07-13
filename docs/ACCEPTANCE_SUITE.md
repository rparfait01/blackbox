# BLACK BOX — standing acceptance suite (the tripwire)

A single suite covering the full known-good flow. **A change is not committable /
pushable unless the ENTIRE suite passes — not a subset, not "the part I touched."**
This is the tripwire so a fixed bug can never silently regress a second time.

## The suite's own rule

**Every bug found from here gets a check added to the suite BEFORE its fix is
committed.** Each break becomes a permanent tripwire. The closure gate is the first
entry (Brief 19). When the suite is green, tag `known-good-<date>` and push.

## Covert-trigger DEVICE MATRIX (manual, MANDATORY *before* deploy — Brief 24 §4)

The covert trigger IS the product, and code-tests + one device keep missing on-device
gesture breaks (press-and-hold iOS callout; double-tap iOS click-fusion). **Any change
that touches the covert trigger gesture, its detection, or the facade trigger element
must pass this matrix ON-DEVICE before it deploys to the live pilot — not after.**

| Platform | Check | Pass |
| --- | --- | --- |
| **iOS Safari** (installed PWA) | Hidden gesture → LIVE event appears on the dashboard + location fix | ☐ |
| **Android Chrome** (installed PWA) | Hidden gesture → LIVE event on the dashboard + location fix | ☐ |
| both | facade byte-identical before/after; a stray single tap does nothing | ☐ |
| both | Settings build stamp == deployed SHA (rule out stale build first) | ☐ |

This is manual (a real gesture on a real phone can't be automated here). Record the
matrix result in the commit/handoff; no `known-good` tag without both platforms signed
off by Royce.

## What runs

`pnpm gate` = `pnpm verify` + `pnpm acceptance`:

- **`pnpm verify`** — `typecheck` + `lint` + `test` (unit) + `build:all`. Fast, local.
  - Unit tripwires (`workers/api/test/messages.test.ts`): the **"I'M OK" location is
    a real, tappable map link** (regressed once to bare coordinates); emergency-alert
    location is a map link too.
- **`pnpm acceptance`** (`workers/api/test/acceptance.mjs`) — the full flow against
  the **DEPLOYED** worker. Self-provisions throwaway accounts and cleans up. Checks:
  1. signup + login, **both modes** (direct + covert), mode persists
  2. add contact + persistence
  3. QR-LINE: manual save refused; pairing start/status (no id ever typed)
  4. remove + reindex (contiguous)
  5. Present / display-mode toggle persists
  6. guardian toggle persists
  7. arm gate — no deliverable recipient → 409
  8. trigger → timed cascade **0/10/20/30/40** (Durable Object alarm) + email delivered
  9. cascade does not halt across a gap (tail/emergency still fires)
  10. **CLOSURE GATE** — a contact CANNOT secure with **no pending user request** (409). *The first tripwire.*
  11. contact **never enters the code** — coordinator `/standdown` is 403
  12. closure **approve** after a code-validated user request → session ends
  13. **duress** request shows threat-ongoing (unsat), never reads as safe
  14. one active event per user — re-trigger **resumes**
  15. operator force-close ends an orphaned active event

## Running it

```
pnpm setup-hooks        # once: activates the .githooks/pre-push gate
pnpm gate               # verify + acceptance (what the hook runs)
```

The coordinator checks (10–13) need `MAGIC_LINK_SECRET` to mint a coordinator token
on the deployed app. Provide it as an env var (`BBX_MAGIC_LINK_SECRET`) or in the
**gitignored** `workers/api/test/.acceptance.env` (`BBX_MAGIC_LINK_SECRET=…`). Without
it the suite **fails closed** on the closure gate — by design, so the gate can never
be skipped. `ADMIN_TOKEN` defaults to `workers/admin_token.txt`. `BBX_ORIGIN`
defaults to the deployed worker.

## Manual checks (not automatable headless)

The suite covers everything reachable over HTTP. Two items still need an eyeball on a
**home-screen-installed** instance and are checked there each release:
- the settings **gear clears the status bar** (safe-area inset) in standalone mode;
- the **Present** toggle knob renders correctly (the API persistence is check #5).
