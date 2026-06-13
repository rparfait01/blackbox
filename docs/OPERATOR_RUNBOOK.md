# BLACK BOX — Operator Runbook

Operator/admin procedures for the deployed pilot. These are **operator actions**,
distinct from anything a user can do in the app. The guiding invariant:

> A user must NEVER be trapped in an active event with no path to closure — **but
> the user still cannot self-close** (that protects a coerced user). Closure comes
> from a guaranteed non-user closer (coordinator → guardian → operator failsafe),
> never from letting the user close freely.

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

---

## 1. Force-close an orphaned active event (the failsafe)

Use when an event is genuinely orphaned: no reachable coordinator, all coordinator
links expired, the user cannot self-close and account deletion is (correctly)
blocked during the live event. This should be rare — the prevention layers below
exist so it stays rare — but it must always be possible.

### Step 0 — Capture the Time Travel reversibility anchor FIRST

D1 Time Travel lets any write be rewound within a 30-day window. Always record the
current bookmark **before** writing.

```bash
cd workers/api
npx wrangler d1 time-travel info blackbox
# Note the bookmark. To rewind later:
# npx wrangler d1 time-travel restore blackbox --bookmark=<BOOKMARK>
```

### Step 1 — Find the orphaned event(s)

Preferred (admin endpoint):

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://blackbox-api.stillpoint-dev.workers.dev/v1/admin/events/active
```

Or directly against D1 (read-only):

```bash
npx wrangler d1 execute blackbox --remote --json --command \
 "SELECT e.id, e.status, e.createdAt, e.coordinatorClaimedAt, u.email
    FROM events e LEFT JOIN users u ON u.id=e.userId
   WHERE e.status='active' ORDER BY e.createdAt DESC;"
```

### Step 2 — Force-close

Preferred (admin endpoint — audited as `operator_force_close`, mirrors the
coordinator-secure shape so custody/closure reporting stays consistent):

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator force-close — orphaned event, no reachable coordinator"}' \
  https://blackbox-api.stillpoint-dev.workers.dev/v1/admin/events/<EVENT_ID>/force-close
```

Equivalent direct D1 write (sets the canonical closed state the device tears down
on, and that unlocks Settings / delete-account):

```bash
npx wrangler d1 execute blackbox --remote --command \
 "UPDATE events SET status='closed', closedAt=(strftime('%s','now')*1000),
    closedBy='operator_force_close', securedAt=(strftime('%s','now')*1000),
    securedBy='operator',
    reasonSecured='operator force-close — orphaned event, no reachable coordinator'
  WHERE id='<EVENT_ID>' AND status='active';"
```

### Step 3 — Verify

```bash
npx wrangler d1 execute blackbox --remote --json --command \
 "SELECT id, status, closedBy, securedBy FROM events WHERE userId='<USER_ID>';"
# The account must show NO status='active' row. The user's app (session-monitor
# polls delivery-status) sees status='closed' and tears the session down →
# dormant + usable; hasActiveEvent() is now false so Settings/delete unlock.
```

If anything looks wrong, rewind to the Step 0 bookmark.

> **Why a server force-close and not "let the user close"?** A coerced user could
> be forced to close. Closure must always come from someone other than the user.
> The operator failsafe is that someone of last resort — defined, audited, and
> reversible — so a break during a fix never traps a user in an open event again.

---

## 2. Prevention layers (so the failsafe stays a last resort)

These are enforced in code; the failsafe above only covers the residual case.

1. **One active event per user (data layer).** Migration
   `0017_one_active_event_and_relink.sql` adds a partial unique index
   `idx_one_active_event_per_user`. `POST /v1/events` resumes the existing active
   event instead of stacking a second; the index is the hard backstop against a
   race.
2. **No arming with no deliverable recipient.** `POST /v1/events` returns
   `409 no_deliverable_recipient` when the account has no contact/guardian on a
   deliverable channel, and `GET /v1/me/contacts` returns `armable:false` so the
   client disables the activate affordance. An alert that notifies no one is the
   deadlock; it is prevented at the source.
3. **Expiry regenerates the path.** The 1-min cron (`reissueExpiredLinks`) mints a
   FRESH coordinator link and re-notifies all current recipients — with full
   provenance (triggered by name/email, triggered at, link expired at, notice sent
   at, contact required to confirm closure name/email) — whenever a link expires on
   an unresolved event. The re-notification always carries a live link.
4. **Bounded new-party escalation.** Cascade → guardian → emergency fallback
   (Brief 11) is unchanged and bounded; the guardian is the always-present
   coordinator of last resort whose link is kept alive by layer 3.

---

## 3. Deploy gate (required for the layers above)

The one-active-event index and link-reissue columns need migration `0017`. Apply
it to the remote D1 and deploy the Worker together:

```bash
cd workers/api
npx wrangler d1 migrations apply blackbox --remote   # applies 0017 (dedupes then indexes)
npx wrangler deploy
```

Migration `0017` first auto-closes pre-existing duplicate active events (keeping
the newest per account, `closedBy='migration_dedupe_active'`) so the unique index
can be created on existing data. Capture a Time Travel bookmark before applying.
