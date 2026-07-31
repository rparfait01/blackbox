# BLACK BOX — VALIDATION AUDIT (read-only) — validate all processes vs design, isolate gaps, recommend (don't apply)

**Mode:** INVESTIGATE AND VALIDATE ONLY. No code changes, no rebuilds. **App is LIVE with a real pilot user —
do NOT disable, take down, or disrupt.** All checks below are observation or read-only queries. Recommendations
are logged, not executed. Any writes touch dedicated TEST accounts only — never the pilot's account.

**Guardrails for a live app:**
- Use dedicated test accounts for any trigger/close/check-in reproduction. Never the pilot's live account.
- Close test events via the normal closure gesture. **Do NOT force-close or delete events in D1** — that's what
  orphaned an event before. Let Brief 20's lock/auto-close handle lifecycle.
- Read-only D1 queries only (SELECT). No schema changes, no deploys.

---

## P0 — HIDDEN TRIGGER RELIABILITY (the live gap)

**Design intent:** a covert press-and-hold on the facade fires an event, byte-identical facade, works on the
devices real users carry (iOS Safari + Android Chrome at minimum).

**Cross-account signal to confirm (read-only):** source distribution across ALL real accounts.
`SELECT source, count(*) FROM events GROUP BY source;` — if `stillpoint-press` (Hidden) ≈ 0 while `direct-tap`
(Visible) dominates across real users, the failure is systemic, not one pilot.

**Isolate the failure point (test account, same device class as the pilot):**
1. Record the PILOT's device + browser + OS version. Record your test device. If they differ, that's suspect #1.
2. On a test account, Hidden mode, on an **iOS Safari** device specifically: perform the hold gesture. Observe:
   - Does the facade long-press fire the handler, or does iOS hijack it (callout menu, text selection, magnifier,
     scroll cancel)?
   - Network: does `POST /v1/events` fire? Absence = gesture never reaches dispatch (client/gesture layer).
     Presence + 200 = it fired and the facade just didn't tell (expected — covert), so verify the event landed
     on the dashboard.
3. Repeat on Android Chrome. If Hidden works on Android and fails on iOS → confirmed platform gesture bug.

**Likely cause (to validate, not assume):** iOS long-press collides with `touch-callout`/`user-select`/
`contextmenu`; pointer-capture (`fe83887`) covers one platform and not the other. **Recommended fix (log,
don't apply):** suppress the iOS callout/selection/contextmenu on the facade trigger element and normalize the
hold on pointer+touch across both platforms; add an iOS-Safari Hidden-trigger row to the acceptance suite.

**Interim operational mitigation (no code):** pilot uses the confirmed-working trigger for their device until
Hidden is validated on it. Do not leave a live user relying on an unverified covert trigger.

---

## MODULE-BY-MODULE VALIDATION (read-only, pass criteria, recommend-don't-apply)

### 1. Identity & Account
- Validate: sign-in/session (`requireSession`); sign-out and delete BLOCKED during a live alert (Brief 20);
  normal access returns after close.
- Method: test account — trigger, attempt settings/sign-out/delete (all refused), close, confirm restored.
- Watch: any path that reaches settings/sign-out during a live alert = Brief 20 regression.

### 2. Trigger
- Validate: Visible tap AND Hidden hold each create exactly one event, both platforms. (P0 above is the Hidden
  half.) Single-active yields one open event per trigger; second trigger doesn't fork.
- Method: test account, both modes, both platforms; read `events` for source + count.
- Watch: armable gate silently suppressing Visible (CC found a `!armable` early-return); Hidden platform failure.

### 3. Capture
- Validate: on trigger, capture (audio/location) starts; location fix present on the event; no
  device-observable tell in Hidden.
- Method: read event rows for location/capture fields after a test trigger; confirm Hidden screen stays
  byte-identical (no indicator).
- Watch: missing location fix; any Hidden visual change on active event.

### 4. Alert Lifecycle
- Validate: exactly one "Alert Triggered" email per event with dashboard link; lifecycle events pushed via
  WebSocket to open dashboard, not additional emails; closure via gesture, dual-consent (Brief 16 §2).
- Method: one test event; count emails (should be 1); watch dashboard WebSocket updates; confirm closure.
- Watch: duplicate emails; closure that's one-way only (you flagged this earlier — validate whether coordinator/
  reciprocal closure works or is still user-only).

### 5. Notification & Cascade
- Validate: cascade order and delivery on real channels (LINE/SMS/email); check-in routes to the DESIGNATED
  contact (Brief 19), honest delivered/not-delivered, never `ok:true` with `recipients:0`.
- Method: test account with a deliverable LINE contact; trigger → confirm cascade delivery; check-in → confirm
  designated contact receives + user sees real confirmation; reassign designation → next check-in follows.
- Watch: SendGrid daily cap (100/day) silently degrading the email tier during a real event — validate email
  isn't the sole channel for any primary recipient.

### 6. Coordination
- Validate: first-responder-wins election (first to engage promotes to sole coordinator; others demote; single
  token-scoped URL); guardian escalation path (60s/180s → user notified → routes to guardian, duress inherited).
- Method: test event with two dashboard recipients; confirm one coordinator, others demoted, one URL; simulate
  coordinator non-response to exercise guardian escalation.
- Watch: two coordinators; escalation not firing on timeout.

### 7. Custody & Data
- Validate: feed-loss closure note locked verbatim ("Safety is at risk. Session closure is NOT an indication of
  safety."); capture custody intact; no orphaned events emitting phantom notifications (Brief 20).
- Method: read event/audit rows; confirm no open events without a reachable owner; confirm no phantom pushes
  after a close.
- Watch: orphaned/ghost events; closure note altered.

### CROSS-CUTTING — Currency (Brief 21)
- Validate: live PWA hash == committed; Worker/PWA versions paired; dormant self-update advances the Settings
  build stamp with no manual reopen; update DEFERS during a live alert (no reload/tell), applies on close.
- Method: read `/version` + Settings build stamp; deploy-verify assertion status; on a test account, confirm
  mid-alert deferral.
- Watch: version.json served from stale CDN cache defeating the assertion (validate the poll cache-busts).

---

## OUTPUT OF THIS AUDIT
A findings log per item: PASS / GAP / BUG, with evidence (query result, capture, screenshot) and a RECOMMENDED
fix — none applied. P0 Hidden-trigger gets the platform matrix result and the operational mitigation confirmed
for the live pilot. Nothing deployed, nothing taken down, pilot uninterrupted.
