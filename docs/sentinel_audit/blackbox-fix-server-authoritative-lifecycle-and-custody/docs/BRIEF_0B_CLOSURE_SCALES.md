# BRIEF 0B — CLOSURE SCALES TO ENGAGED PARTIES

**Status verified 2026-07-23: NOT BUILT. Dual-consent is hardcoded to 2.**
**This is a MODEL fix, not a patch. Do not add a `if (solo)` branch.**
**Exact locations known — no diagnosis needed.**

---

## THE BUG (confirmed in code)

| Location | Current behavior |
|---|---|
| `closure-consent.ts:113-119` | `evaluateConsent` **always** requires both user **and** support assent |
| `index.ts:1288-1292` | Solo / unclaimed → `awaiting_support` → **stays open indefinitely** |
| `closure-timeout.ts:162,175-196` | The only consent-free release: 2h dark+unclaimed auto-close |

**A solo survivor has no consent path to close their own event.** The only exits are the 2h timer, feed-loss, or
admin force-close. Royce hit this live; CC cleared that event by hand.

**Single point of failure:** if the 2h backstop ever regresses, a survivor-alone event is unclosable. There is
currently **no guard test** on any of this.

---

## THE MODEL

Closure requires consent from **every party actually engaged with the event.** Dual-consent is not the rule — it
is the case where two parties are engaged. **The required-consent set is derived from event state, never
hardcoded to 2.**

| Engaged parties | Required to close |
|---|---|
| Survivor only (solo, unclaimed, or no coordinator online) | **Survivor alone** |
| Survivor + engaged support/coordinator | **Both** — unchanged |

This is the same move as one-trigger / one-dispatcher: name the real model, delete the special cases. Solo,
unclaimed, and no-coordinator-online stop being distinct cases — they are all *"everyone engaged has consented."*

## §1 — DEFINE "ENGAGED" (the crux — get this right)

**Engaged = a support party has taken an explicit action on this event.** Claimed the coordinator role, opened
the response view and acted, or submitted an assent.

- `[A]` **Delivery is NOT engagement.** A text that was delivered but never opened means nobody is present. At
  3 a.m. that is the common case — treating "notified" as "engaged" leaves the deadlock in place for exactly the
  survivors who need it gone.
- `[A]` Engagement is derived **server-side** from event state, evaluated at the moment of consent evaluation.

## §2 — ANTI-COERCION IS PRESERVED (do not lose this)

Dual-consent exists so a survivor under duress cannot be forced to close while a responder is watching. **That
property only has meaning when a responder actually is watching** — which is precisely when engagement exists.

- `[A]` The instant a support party engages, both consents are required again. No exception, no override.
- `[A]` Solo self-close retains the existing duress semantics of the closure gesture. The deadlock goes; the
  protection stays.

## §3 — RACE SAFETY

- `[A]` The consent set is evaluated **server-side and atomically** at evaluation time. If a coordinator is
  engaged at that instant, dual-consent applies.
- `[A]` If a survivor closes solo and a coordinator engages a moment later, **closed is closed** — no window
  where both a solo close and a claim succeed on the same event.

## §4 — BACKSTOPS STAY

- `[A]` The 2h dark+unclaimed auto-close (`closure-timeout.ts`) **remains untouched.** It is no longer the only
  path for a present survivor, but it stays as the net for an abandoned event.
- `[A]` Feed-loss and admin force-close paths unchanged.

## §5 — LOCK UX (related symptom, fix here)

The live-alert lock currently loads Settings then bounces the user out with no explanation.

- `[A]` The lock must **say** *"Unavailable during an active alert"* rather than silently load-then-revert.
- `[A]` §0a: Visible/Settings side only. Never a tell in Hidden.

## SCOPE

Change **only** the consent-set derivation + the lock message. Do **not** touch trigger, capture, cascade,
single-active, currency, or the anti-coercion behavior when a support party is engaged.

## ACCEPTANCE

- `[L]` Solo user, no coordinator → **closes their own event immediately.** No wait, no deadlock.
- `[L]` Support party engaged → dual-consent still required; survivor alone **cannot** close.
- `[L]` Contact notified but never opened → still treated as **solo** (survivor closes alone).
- `[L]` Coordinator engages mid-close → dual-consent applies; no double-close.
- `[L]` 2h auto-close still fires for an abandoned event.
- `[L]` Settings during a live alert says *"unavailable during an active alert"* — no silent bounce.
- `[A]` Consent evaluates a **derived party set**, not a hardcoded 2. Grep proves no `if (solo)` special case.
- `[A]` **Guard tests added** — solo-close, dual-consent-preserved, notified-but-not-engaged, race. This behavior
  currently has zero guard coverage; it must not ship without it.
- `[L]` Trigger / capture / check-in / lock / currency unregressed. §0a Hidden byte-identical.

## DONE
One closure model — consent scales to the parties actually engaged — killing the solo/unclaimed/no-coordinator
deadlock class in a single change, anti-coercion intact whenever a responder is present, race-safe, backstops
retained, lock UX honest, and guard tests added where there were none. Committed **and pushed**; both deploy
halves currency-asserted; phone sign-off.
