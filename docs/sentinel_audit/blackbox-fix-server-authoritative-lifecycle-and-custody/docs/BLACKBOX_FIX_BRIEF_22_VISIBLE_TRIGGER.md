# BLACK BOX — FIX BRIEF 22 — Visible trigger: the last isolated break

**Floor:** current known-good + Briefs 19/20/21, matched client+server on production. Do not regress
Hidden trigger, closure, check-in, live-alert lock, or currency.
**Mode:** deployed production. Proof is a live event from a real Visible tap on the phone.
**Context:** with cache, account, orphan, and deploy-staleness all eliminated, Visible-trigger-dead is now a
trustworthy, isolated signal. Hidden fires clean through the SAME server create path → server proven → the
Visible break is client-side.

---

## SECTION 1 — Diagnose with a log, one tap  `[A]`

Put a log at the very top of Visible `activate()` (before any gate), log the `armable` value, and log
immediately before the `POST /v1/events` fetch. On the phone, Visible mode, tap Activate once, read it +
the Network tab. Determine which:

- **Fork A — `activate()` never logs:** the hold/pointer gesture isn't reaching the handler on mobile touch.
  The `fe83887` pointer-capture fix landed on Hidden's facade but not the Visible activate control. → §2A.
- **Fork B — `activate()` logs, `armable` false, early-returns, no POST:** the armable gate is suppressing the
  trigger. → §2B (this is the likely one — CC already found Visible gates on `!armable`, Hidden does not).
- **Fork C — POST fires, 200:** not a trigger bug. Event is created; Visible screen doesn't render the active
  state. → §2C (display fix).
- **Fork D — POST fires, non-2xx:** server rejects Visible's payload (differs from Hidden's). Read the body,
  fix the payload to match Hidden's. → surface if it implicates the server before editing it.

Name the fork, on evidence, in the commit.

---

## SECTION 2 — Fix to the fork

### §2A — pointer/gesture not firing on Visible (mobile touch)
Apply the same pointer-capture / hold handling used on Hidden's working trigger to the Visible activate control.
One trigger dispatch, two entry surfaces (facade hold / instrument activate) — converge them. Client only.

### §2B — armable gate suppressing the trigger  *(PRINCIPLE, not just a patch)*
**A safety-app panic button must never silently do nothing.** Hidden fires unconditionally and delivers fine;
Visible must not silently refuse because a recipient predicate returned false. Fix:
- Remove the blocking `!armable` early-return from Visible. The trigger ALWAYS creates the event, same as Hidden.
- A missing/undeliverable recipient is **surfaced** to the user (Visible only — never a tell in Hidden), never a
  silent no-op. If you want an armable signal, make it a non-blocking warning, not a gate.
- **Reconcile the two predicates:** CC found `hasDeliverableRecipient` (drives `armable`) and
  `hasReachableRecipient` (any deliverable contact) can disagree. Make the trigger path and the delivery path
  read ONE predicate so Visible can't refuse to fire on a config Hidden happily triggers and delivers on.

### §2C — event created, Visible not rendering active state
Fix the Visible active-event render so a live event shows (armed/active UI + cascade reflected). Server side is
fine; this is Visible display only. Do not touch the create path.

---

## ACCEPTANCE
- `[A]` commit names the fork with the logged evidence.
- `[L]` Visible → real activate on the phone → a LIVE event surfaces on the dashboard AND the cascade fires —
  same result as Hidden. Screenshot the dashboard event.
- `[L]` Visible activate with NO deliverable recipient → still creates the event, and surfaces the
  no-recipient state to the user (Visible) — never a silent no-op.
- `[L]` No regression: Hidden trigger, closure, check-in (19), live-alert lock (20), currency (21) all still
  pass; single-active still yields exactly one open event; §0a Hidden facade byte-identical (no tell).

## DEFINITION OF DONE
Passes on the deployed app, proven live on the phone (live event from a Visible tap; no silent refusal). Check
added to the acceptance suite; committed naming the fork and cause. This closes the core capture→cascade→close
pipeline on a matched, self-current build — Royce phone sign-off, then tag known-good.
