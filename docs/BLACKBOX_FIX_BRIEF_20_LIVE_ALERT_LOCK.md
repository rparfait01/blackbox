# BLACK BOX — FIX BRIEF 20 — Live-alert state lock (settings / sign-out / delete) + no orphaned events

**Floor:** current known-good + Brief 19 check-in. Do not regress trigger, closure, or check-in.
**Mode:** deployed production, both Present modes. Proof is live behavior on the phone, not tests.
**Priority:** P0. This is the root cause of the orphaned-alert / phantom-notification / dead-trigger mess.

---

## ROOT CAUSE ON RECORD (do not re-diagnose)

A live alert was orphaned: settings was reachable during a live alert → sign-out was allowed during a live
alert → the device session detached from an event still open on the server. Result: a "live alert" notification
with no alert visible in the app (owning account signed out/deleted), and new triggers silently deduped against
a ghost event via single-active. The only guard that held was delete-block. The fix is to make an active alert
lock the account down until it is properly closed, and to guarantee no event can outlive the ability to close it.

---

## LOCKED SPEC (Royce, restated — this is the target behavior)

- One trigger → exactly ONE outgoing alert.
- Two display modes; the mode it was triggered in determines display. Triggered in Hidden → display stays
  Hidden (covert facade, byte-identical, no tell — unchanged §0a guard).
- **No settings access during a live alert.**
- **No sign-out during a live alert. No account-delete during a live alert** (delete already blocks — keep).
- Once the alert is cleared → normal operational settings/sign-out/delete return.
- The ONLY way out of a live alert is the closure gesture — never by abandoning it (sign-out/delete/switch).

---

## SECTION 1 — Lock the account during a live alert  `[A→L]`

While an event is live for the account:
- **Settings inaccessible, both modes.** Visible: the settings entry is disabled/hidden and cannot open
  contacts/account/sign-out/delete. Hidden: the facade never exposes real settings anyway — verify the facade
  path cannot reach real settings during a live alert, and stays byte-identical (no new tell). Do NOT add a
  visible "locked" indicator in Hidden.
- **Sign-out refused.** Attempting sign-out during a live alert is blocked with a clear reason ("close the
  active alert first"). No path signs out while an event is open.
- **Account-delete refused** (already works — add to acceptance so it can't regress).
- On closure (gesture, dual-consent per Brief 16 §2), all three return to normal in the same session, no reload.

**Acceptance:**
- `[L]` live alert (Visible): settings won't open; sign-out refused; delete refused. Close → all three work again.
- `[L]` live alert (Hidden): facade cannot reach real settings; screen byte-identical to dormant; sign-out/delete
  unreachable. Close → normal returns.

---

## SECTION 2 — No orphaned events  `[A→L]`

An open event must never outlive the owner's ability to see and close it.
- **Confirm and state the single-active scope** (per-account vs global) in the commit. If global, change it to
  per-account/per-user — one account's live event must not block triggers on another account.
- **No silent dedup against an invisible event.** If a trigger hits single-active and an event is already open
  for that account, the owner must be able to surface and close it — never a no-op the user can't explain.
- **Orphan recovery:** an open event whose owning account is signed out or deleted must be resolved, not left
  live emitting notifications. Since §1 blocks sign-out/delete during a live alert, the primary path is
  prevention — but add a server-side safeguard: any event open past a bounded max with no reachable owner is
  auto-closed with the feed-loss closure note ("Safety is at risk. Session closure is NOT an indication of
  safety."), so it stops firing and is auditable.
- **Notification consistency:** a live-alert notification must correspond to an event the owning account can see
  and close. A closed/orphan-resolved event emits no further notifications.

**Acceptance:**
- `[A]` single-active scope named; if it was global, now per-account.
- `[L]` trigger while an event is open for the account → owner can surface + close it; no silent no-op.
- `[L]` no phantom notifications: after an event is closed/resolved, zero further "live alert" pushes.
- `[L]` an orphaned open event (simulate) is auto-closed within the bound and stops notifying.

---

## NO-REGRESSION GUARDS
Trigger (both modes), closure (gesture, dual-consent), check-in (Brief 19), §0a covert byte-identical facade —
all still pass. Single-active still yields exactly one open event per trigger.

## DEFINITION OF DONE
Both sections pass on the DEPLOYED app, both modes, proven live on the phone (settings/sign-out/delete refused
during alert, restored after close; no phantom notifications; no orphan). Checks added to the acceptance suite;
committed naming the single-active scope and what changed. Phone sign-off before any known-good tag.
