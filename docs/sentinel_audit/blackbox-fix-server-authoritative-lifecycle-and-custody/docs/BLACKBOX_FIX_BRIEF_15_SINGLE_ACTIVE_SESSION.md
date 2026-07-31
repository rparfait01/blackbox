# BLACK BOX — Brief 15: one open session per account (kill zombies + enforce the invariant)

Observed: an event has been open ~72h; a NEW session was started from the user's phone WHILE that one
was live; closing the new session left the account "active" — it falls back to the old open event.
Two defects: (1) multiple concurrent open events per account are possible; (2) account-active is
computed as "any open event exists," so closing one orphans the others and the app resolves back into
them. This is Module 4 (lifecycle), server-side.

## Step 0 — NOW: kill every open session on the account (not just one)
- Read the actual events schema from the migrations (table + status column + close columns). Do not
  guess it.
- List EVERY non-closed event for the account and show it (id, status, created_at).
- Close each via `POST /admin/event/:id/close` (ADMIN_TOKEN) so each gets a proper audit/disposition
  row. Loop over all ids — the bug is that there is more than one.
- If the admin endpoint isn't deployed, close via D1 but write the same fields the normal closure path
  writes (status, closed_at, disposition, audit) — do not leave a half-closed row.
- Confirm: after the sweep, the account resolves to FULLY dormant, zero open events.

## Root cause to fix (name it in the commit)
- Trigger inserts a new open event with no guard against an existing open event for the account.
- "Account active" = "an open event exists," with no single-active constraint, so orphans accumulate
  and the client latches onto whichever open event remains.

## Fix — Module 4 only (trigger guard + single-active resolution)
1. **One open event per account, enforced server-side.** A trigger while the account already has an
   open event must NOT create a second one. Enforce it where it can't be raced — a DB-level guard
   (unique/partial index on account + open-status, or a transactional check-then-insert), not just an
   app-level `if`.
2. **Account-active resolves to exactly that one event.** Closing it resolves the account to
   not-active with zero orphans. No code path may leave an open event unreachable from the app.
3. Idempotency + server-truth (E0) unchanged; disposition/duress (E4) unchanged.

Do not touch: capture, notification/cascade, custody, the facade, the Visible UI. Trigger guard and
lifecycle resolution only. If the DB guard needs a migration, that's in scope for THIS fix — flag it
in the commit, don't reach into other modules' tables.

## SURFACED DECISION — Royce's call (do not let Claude Code pick silently)
When the user triggers while a session is already open, what should happen?
- **(A) Re-fire / escalate the existing event** — treat it as a repeat signal, which ties into the
  E3 repetition→tampering path. **Recommended for a duress tool:** a second press under threat should
  intensify the live event, not fork a new one.
- **(B) Block the new trigger, keep the existing event as-is.**
Default to (A) unless Royce says otherwise. Either way, NO second open event is created.

## Prove on device — both directions, both modes
- `[L]` Start a session → attempt to trigger again → NO second open event exists (per the chosen
  behavior); query confirms exactly one open event for the account.
- `[L]` Close the active session → account resolves to fully dormant; NO fall-back to any open session.
- `[L]` After the Step 0 sweep, a fresh query shows zero open events before testing.
- Both Present modes; §0a byte-identical still holds in Hidden.

Commit naming the actual cause. No `known-good` tag without phone sign-off.
