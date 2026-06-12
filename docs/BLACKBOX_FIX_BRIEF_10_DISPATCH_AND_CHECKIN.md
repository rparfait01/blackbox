# BLACK BOX — Brief 10: Multi-Contact Dispatch Fix + Check-in ("I'm OK")

Device-verify on a clean build.

## P0 — Alert not delivered to all contacts

In testing, a newly added second contact did NOT receive the LINE alert when the session
activated — only the first contact was notified.

- The activation dispatch must fan out to ALL configured contacts (and the guardian, per the
  escalation rules in Brief 9), each through their own channel (LINE / SMS / email).
- A newly added contact must be included immediately — no stale or cached recipient list.
- Verify with two or more contacts on different channels; confirm each one receives the alert.

## Feature — Check-in ("I'm OK")

Philosophy: this is the autonomy counterpart to the alert. The alert says "I'm in danger"; the
check-in says "I'm OK." It is the inverse of continuous-tracking apps — the person voluntarily
reassures, on their own terms, and no one is watching by default. For someone relearning that it
is fine to go out and live without being monitored, that distinction is the entire point.

- A simple, deliberate button, clearly SEPARATE from the covert alert trigger — no chance of
  confusing the two.
- One tap sends a brief, NON-emergency message to the chosen recipients (guardian and/or
  contacts): "[User] checked in — I'm OK" + timestamp.
- NO location by default. That is the whole point — reassurance, not tracking. Offer an optional
  per-tap "include my location" only if the user chooses it for that check-in.
- Distinct from an alert in every way: different message styling, NO capture (no audio, video, or
  recording), no event/session created, no coordinator, no escalation. It is just a ping.
- Recipients configurable (default: guardian; user may add contacts).
- Dashboard: the recipient sees "Last check-in: [time]" — a gentle reassurance line, never a live
  map or tracker.

## Acceptance criteria (device-verified, clean relaunch)

1. With two or more contacts, activation notifies every configured contact on their channel, and a
   newly added contact is included.
2. The check-in button sends "I'm OK" + timestamp to the chosen recipients, with no location
   unless the user opts in for that tap, and creates no alert or session.
3. Recipients see a "last check-in" time, and nothing about the check-in resembles or triggers the
   emergency flow.
