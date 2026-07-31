# BLACK BOX — Fix Brief 7: Coordinator Claim & Dashboard Role

Work order for Claude Code. Device-verify on a clean relaunch (after the Brief 6 service-worker
fix is in, so the device runs the deployed build).

## Context

The first guardian to open the emailed link received the NOTIFIED view ("another responder is
already coordinating this alert") when they were the ONLY responder. Leading cause: coordinator
is claimed on passive page load (a GET), so an automated link scan (Gmail / safe-browsing /
prefetch) or a duplicate client load claims the role before the human acts. The same root cause
most likely breaks "Share with authorities": the human never became coordinator, so never got the
`bbcoord` cookie → 401 / empty modal.

## Step 0 — Confirm the cause

- Check D1 / Worker logs: which user-agent claimed coordinator for the test event, and at what
  time relative to send. A scanner / Google UA claiming within ~seconds of the email going out
  confirms passive-GET claiming. (The fix below is correct design regardless, but confirm.)

## P0 — Claim coordinator on deliberate action, never on passive load

- The dashboard GET renders a neutral state for an unclaimed event: the live view is visible to a
  valid token holder, with an explicit "Take coordination / I'm responding" action. No claim on
  GET.
- The coordinator claim happens ONLY on that explicit POST. Bots scan; they do not post.
- On claim, set the `bbcoord` cookie (first-party, Worker origin) and record the coordinator
  identity on the event.

## P0 — Role is sticky and idempotent

- The same identity reloading or reopening the link KEEPS coordinator — never demoted to notified
  on a refresh or a second load.
- A genuinely different, second guardian gets the notified view (this is correct behaviour).

## P1 — Share with authorities (tie-in)

- With the human now actually coordinator and holding `bbcoord`, the dispatch-link mint
  authorizes. Re-verify Share produces a populated QR + copyable link and Close dismisses it
  (Brief 6 LT5-2..LT5-5 still apply).

## Side checks (separate from the above — do not conflate)

- **SESSION ENDED**: determine why the event read as closed on open — a TTL, the still-open
  refresh/standdown path, or a leftover prior test. Track it as its own item.
- **Location "awaiting fix"**: if this is awaiting-GPS-fix, confirm the dashboard updates WHERE
  once the fix acquires rather than staying stuck on the placeholder.

## Acceptance criteria (device-verified, clean relaunch)

1. The first human to open the link sees a neutral first-responder state and becomes coordinator
   ONLY on tapping "Take coordination" — and an emailed-link scan does not consume the role.
2. That coordinator refreshing / reopening stays coordinator.
3. As coordinator, Share with authorities returns a working QR + copyable link.
4. A second, distinct guardian sees the notified view.
