# BRIEF 33 FIX A — COORDINATOR POLLING: A LOOP THAT NEVER STOPS

**Type:** FIX A on Brief 33 (three-role dashboard)
**Priority:** P0 — the alert path is currently down
**REQUIRES:** Brief 40 §F green (`3dbef2b`). Nothing else. **This ships first — every other brief
in the queue requires it.**
**Ship order:** FIRST. Nothing else deploys before this.
**Floor:** Briefs 35–40 §F. Zero regression to the coordinator's live view.
**Mode:** written and committed now; deployed when the Cloudflare daily counter clears.

---

## CORRECTIONS

**BRIEF 033 §DASHBOARD — corrected to read:**
"Every polling loop and socket on a coordinator surface is bounded: it stops when the event
reaches a terminal state, slows when the tab is hidden, and backs off on failure. A loop with
no stop condition is a defect regardless of interval."
Path: `workers/api/src/dashboard/page.ts`

---

## THE DEFECT (settled)

`page.ts:777` — `setInterval(poll, 3000)` against `/v1/c/:id/state`. No `clearInterval`, no
`visibilitychange` handler.
`page.ts:788` — `ws.onclose` reconnects at a fixed 3s. No backoff, no cap.

Consequences:

- A tab left open on a **closed** event polls every 3s indefinitely. All five production events
  are closed.
- One open tab ≈ 28,800 requests/day. Two, plus a flapping socket ≈ 115k — over the 100k free-
  tier daily cap on their own.
- **The failure is self-sustaining.** When the Worker is over quota it fails, the socket never
  connects, so it retries every 3s, and each retry is another request against the exceeded cap.
  The breach generates the load that maintains the breach. It cannot recover without the daily
  reset.

The Worker is the entire alert path. Over the cap, a trigger creates a local capture and
notifies nobody — the Brief 35 silent failure, arriving through the billing layer.

---

## §A — STOP ON CLOSURE, AND SAY SO

- Clear the poll timer and close the socket when the event reaches any terminal state.
- Render an explicit banner: **"This event closed at [DTG]. This view is no longer live."**
  Reload for current state.
- A view that silently stops updating is worse than one that stops loudly. Honest-status applies
  to the coordinator surface, not only the survivor's.

## §B — HIDDEN TAB

| Condition | Interval |
|---|---|
| Event live, tab visible | 3s — unchanged |
| Event live, tab hidden | 30s |
| Event closed | Stopped entirely, per §A |

On `visibilitychange` to visible: fetch **immediately**, then resume 3s. Never make a coordinator
wait out an interval to see current state.

Live + hidden must keep polling. A coordinator with the tab backgrounded during an active alert
cannot miss an update — that is the whole product.

## §C — SOCKET BACKOFF (the P0)

- Exponential with jitter: 3s, 6s, 12s, 24s, 48s, capped at 60s.
- Attempt ceiling. On exhaustion, stop and show **"Connection lost — reload to reconnect."**
- Never reconnect on a closed event.
- The 3s fixed retry is what made a quota breach self-sustaining. This section is why the brief
  is P0.

## §D — NOTIFIED VIEW

Same file, 5s poll, never cleared. Apply §A and §B. Same banner, same hidden-tab rule.

## §E — ANTICIPATED GAPS (build for these now)

1. **Server-side ceiling.** Client-side bounds are advisory — an old cached page keeps the old
   loop. Add a per-token request ceiling on `/v1/c/:id/state`: beyond a stated rate, return a
   terminal response instructing the client to stop. **Never rate-limit a live event's first
   poll** — the ceiling is generous and only bites on runaway loops.
2. **Closed-event state endpoint.** `/state` on a terminal event returns a terminal payload the
   client acts on, so a stale page stops even if its JS predates this fix.
3. **Service worker.** Confirm the dashboard is not cached by a service worker that would serve
   the old polling page after deploy. If it is, bump the cache key.
4. **No other unbounded loops.** Grep every `setInterval`, `setTimeout` retry, and `onclose`
   across dashboard, notified view, verifier page, and PWA. Report each with its stop condition.
   Any loop without one is in scope for this brief.

## §F — OBSERVABILITY (the reason this went unseen)

There is no request-volume visibility. A billing threshold presented as a platform incident.

- Wire the GraphQL Analytics query into the readiness panel.
- Panel reports request headroom against the plan limit.
- **Error-level alert at 80%.**
- Run the query once after deploy and report actuals against the arithmetic.

---

## ACCEPTANCE

Deferred until the counter clears. No production verification before then.

1. Closed event, tab open one hour → **zero** requests. Banner shown.
2. Live event, tab hidden → 30s confirmed in the log.
3. `visibilitychange` to visible → immediate fetch, back to 3s.
4. Kill the API, watch the socket → 3/6/12/24/48/60 observed, ceiling reached, stop message
   shown. **Prove no request is made after the ceiling.**
5. Live event, tab visible → coordinator sees updates within 3s. **This is the guarantee. Do not
   regress it.**
6. Notified view: items 1–3.
7. Stale cached page → server-side terminal response stops it.
8. §E4 loop inventory reported; every loop has a stated stop condition.
9. Readiness panel reports headroom; 80% alert fires.
10. Full acceptance suite, 90/90 — **run once, and report its request cost.**

---

## CARRIES FORWARD (open, owned by)

- Deploy toolchain and quota classification. **Brief 35 Fix A.**
