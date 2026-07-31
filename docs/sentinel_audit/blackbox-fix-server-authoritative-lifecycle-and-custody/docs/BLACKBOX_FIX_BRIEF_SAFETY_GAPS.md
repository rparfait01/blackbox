# BLACK BOX — FIX BRIEF (assign next free git number) — LIFE-SAFETY GAPS: fail loud, never silent

**PRODUCTION. LIVE PILOT. ZERO REGRESSION.** Ships alongside the trigger-unify brief, but each section below is
**independently committable and independently regression-tested** — nothing is crammed into one risky commit.
**Principle:** every gap here is a SILENT failure. The fix makes each one fail LOUD. No silent no-delivery, no
silent deadlock, no silent dead-end. Ever.

---

## OPS — DO TODAY (Royce, not code — a commit CANNOT do these)

These are LIVE gaps in production right now. Do them before relying on this in any real event.

1. **SendGrid is exhausted → email-only accounts are un-notifiable RIGHT NOW.** Restore a paid/verified SendGrid
   tier. Until it's restored, ensure **no account has an email-only contact** — every account needs at least one
   LINE or SMS channel. `terekei@icloud.com` is email-only today = currently un-notifiable. Fix that account now.
2. **Zero guardians on every real account → 180s escalation has no target.** Add a guardian to every real
   account so escalation can land. (The code backstop is §3, but a real guardian is the actual fix.)

Confirm both done. These don't wait for a commit cycle.

---

## §1 — Dark+unclaimed events must not lock the account for 24h  `[A→L]`  *(server cron only)*

**Gap:** an event that goes device-dark and is never claimed by a coordinator stays open up to 24h; Brief 20's
lock then holds the user out of their own account that whole time (the pilot is in this state now).

**Fix — server-side auto-close, scoped tightly:**
- An event that is **BOTH dark (no heartbeat for the bound) AND unclaimed (no coordinator ever engaged)**
  auto-closes on a bound of **[ROYCE SETS — recommend ≤1h]**, with the verbatim feed-loss note
  ("Safety is at risk. Session closure is NOT an indication of safety.").
- **Scope guard — do NOT auto-close otherwise:** an event with a live feed, OR with a coordinator engaged, is
  NEVER auto-closed by this rule. It runs to proper dual-consent closure. This rule touches zombies only.
- **No user-abort path.** Deliberately omitted — a user-can-close path reopens the coercion vector (attacker
  closes a fresh alert). Closure stays dual-consent for claimed/live events; the gesture's duress semantics are
  untouched.

**Acceptance:**
- `[L]` a dark+unclaimed test event auto-closes within the bound, feed-loss note attached, account unlocked.
- `[L]` a live-feed event and a coordinator-claimed event are NOT auto-closed by this rule (regression guard).

---

## §2 — All-channels-failed must fail loud  `[A→L]`  *(cascade + config surfacing)*

**Gap:** when delivery reaches zero reachable recipients (channel exhausted like `sendgrid_401`, or account
un-notifiable), the system does not surface it — an alert can fire and reach no one, silently.

**Fix:**
- Detect **all-channels-failed / zero-delivered** at event time and SURFACE it loud: coordinator dashboard +
  audit log; and to the user where safe (never a tell in Hidden). A cascade that delivered to nobody is never
  recorded as anything but a failure.
- **Un-notifiable account is surfaced at config/trigger time** — if an account has no reachable channel, warn
  the user to add a working one. **The trigger STILL fires and STILL captures** — this is a warning, NOT a gate.
  (This is the armable concept done right: warn, never block, never silent.)
- Do not change the cascade order or the create path — only add failure detection + surfacing.

**Acceptance:**
- `[L]` an event where every channel fails → dashboard + audit show a loud delivery-failure, not a success.
- `[L]` an un-notifiable account → user warned to add a channel; trigger still fires + captures.
- `[A]` no regression to cascade order or delivery for reachable accounts.

---

## §3 — Escalation with no guardian must not dead-end  `[A→L]`  *(escalation only)*

**Gap:** 180s escalate-to-guardian dead-ends silently when no guardian exists (every real account today).

**Fix:** when escalation fires and finds no guardian target, it does NOT vanish — it re-notifies the available
contacts and surfaces the missing-guardian gap to the dashboard + audit. Never a silent dead-end. (Real fix is
adding guardians per the ops list; this is the loud backstop.)

**Acceptance:**
- `[L]` escalation on a guardian-less account re-notifies contacts and logs the gap; nothing silently vanishes.
- `[A]` escalation with a guardian present is unchanged (regression guard).

---

## ZERO-REGRESSION GUARD (all sections)
Trigger (both modes), single-active, dual-consent closure, live-alert lock (20), check-in (19), currency (21),
capture+location, §0a Hidden facade byte-identical — all still pass. §1 must not auto-close live/claimed events;
§2 must not alter cascade order; §3 must not change guardian-present escalation. Full acceptance suite green
before any tag.

## DEFINITION OF DONE
Ops items confirmed done by Royce. Each code section committed independently, proven live on the phone (loud
failure surfaced, zombie auto-closed, escalation backstopped), new acceptance rows added. No `known-good` tag
until Royce confirms on the phone. These close the life-safety gaps the audit surfaced — none deferred.
