# BLACK BOX — FIX BRIEF 21 — Currency guards: no stale deploy, no stale client

**Floor:** current known-good + Briefs 19/20. Do not regress trigger, closure, check-in, or the live-alert lock.
**Mode:** deployed production, both Present modes.
**Why:** production ran new Worker + 2-week-old PWA (deploy landed as Preview, not master). Two staleness layers
caused it — deploy-target and SW cache. Fix both; they are separate.

---

## SECTION 1 — Deploy currency (the layer that cost two weeks)  `[A]`

The client was never on production; `deploy:pages` targeted Preview while prod branch is `master`. No runtime
refresh can fix a build that isn't deployed. Make it impossible to ship to the wrong target silently.

- **Pin the deploy target.** `deploy:pages` always deploys to the production branch (`--branch=master` or
  project prod branch). No path leaves a prod deploy as Preview-only.
- **Post-deploy currency assertion.** After deploy, fetch the live production build hash and assert it equals
  the just-committed hash. Mismatch → the deploy script FAILS LOUD (non-zero exit, printed diff). This is the
  guard that would have caught this on day one.
- **Same for the Worker↔PWA pairing.** Print both live versions (Worker version, PWA build hash) at the end of
  every deploy so a server-newer-than-client split is visible immediately, not two weeks later.

**Acceptance:**
- `[A]` `deploy:pages` targets production only; a forced-Preview deploy is not reachable from the script.
- `[A]` deploy ends by printing live PWA hash + live Worker version and asserting PWA hash == committed hash;
  a deliberate mismatch makes the script exit non-zero.

---

## SECTION 2 — Runtime currency (service-worker cache)  `[A→L]`

Even correctly deployed, the SW can serve a stale client until full close/reopen. Make the client self-update —
safely.

- **SW lifecycle:** `skipWaiting` + `clients.claim()`; precache revisioned assets; old caches cleaned on
  activate (no stale files linger).
- **Version check:** client knows its own build hash and checks the live production hash (a `/version` file or
  endpoint) on foreground/resume. On mismatch, the client is stale and an update is pending.
- **SAFE APPLICATION — gated on alert state (critical for this product):**
  - **Dormant:** apply the update and reload silently. Currency by default.
  - **Live alert (either mode):** DEFER. Never reload, never drop the capture session or coordinator WebSocket
    mid-alert. Apply the pending update automatically once the alert closes and the app is dormant.
  - **Hidden mode:** NEVER surface an update banner/indicator — it is a tell and breaks the §0a byte-identical
    facade. Updates in Hidden apply silently on the next dormant load only.
  - **Visible + dormant:** a subtle "updated" state is acceptable; a manual "refresh now" affordance is fine.
- **Build stamp:** keep the build-hash line in Settings (Visible) so currency is verifiable by eye; it must
  reflect the actually-running SW build, not the committed source.

**Acceptance:**
- `[A]` SW uses skipWaiting + clientsClaim; activate purges old caches; client checks live hash on resume.
- `[L]` deploy a new build → open the app dormant → it updates without a manual close/reopen; Settings build
  stamp advances on its own.
- `[L]` deploy a new build while an alert is LIVE → NO reload, capture + WebSocket uninterrupted, no tell in
  Hidden → close the alert → update applies automatically, stamp advances.
- `[L]` Hidden mode never shows an update banner/indicator under any condition.

---

## NO-REGRESSION GUARDS
Trigger (both modes), closure, check-in (19), live-alert lock (20), §0a covert byte-identical facade — all
still pass. A refresh never fires during a live alert and never leaves a device on a build older than production
once dormant.

## DEFINITION OF DONE
Section 1 proven by a deliberate mismatch failing the deploy; Section 2 proven live on the phone (dormant
auto-update advances the stamp with no manual reopen; live-alert defers then applies on close; no Hidden tell).
Checks added to the acceptance suite; committed. Phone sign-off before any known-good tag.
