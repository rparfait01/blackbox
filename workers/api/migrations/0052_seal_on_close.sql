-- BLACK BOX backend schema v52 — sealing becomes automatic (Brief 40 §F).
--
-- WHAT THE QUERY FOUND. `exportPackage` was the only writer of the vault, and its only caller
-- was GET /v1/c/:id/export, gated on a VERIFIED RECIPIENT. Nothing sealed on close; nothing
-- sealed on a timer. On production: 0 recipients, 0 bindings, 0 recipient_actions,
-- 0 custody_transfers, 0 vault_objects — against 5 closed events, 5 coordinator_claimed and
-- 6 coordinator_view. Coordinators used the dashboard on every event; nobody ever completed
-- the recipient identity ceremony, so the gate never opened and nothing was ever sealed.
--
-- The gate was not broken. The system simply never sealed anything BY ITSELF: a survivor's
-- evidence became a sealed artifact only if some third party later chose to export it. Every
-- retention and custody-vault statement was therefore vacuous in production — the same shape
-- as Brief 36's envelope flag that had encrypted nothing for two months.
--
-- §F1 — sealing now happens on EVERY terminal state, and abnormal terminations matter most: a
-- seized or destroyed phone must produce a sealed artifact with nobody acting.
--
-- §F2 — CLOSURE NEVER WAITS ON SEALING. A close completes on its own path and enqueues a row
-- here; a sealing failure can never fail, delay, or reverse a closure. That ordering is not a
-- performance choice — closure is the survivor's exit from a live alert, and nothing about
-- archival may stand between her and it.
--
-- §F4 — IDEMPOTENT BY EVENT. eventId is the primary key, so a second enqueue is a no-op and a
-- second seal returns the existing manifest. Re-export never re-seals.
--
-- The cron drains this, but the drain ALSO discovers closed-and-unsealed events directly, so a
-- close path that forgets to enqueue is still covered. The table is the work record and the
-- retry/alert surface; the discovery query is the guarantee.

CREATE TABLE IF NOT EXISTS seal_pending (
  eventId TEXT PRIMARY KEY,
  -- Which terminal state produced this: user_close | dual_consent | feed_lost | orphan |
  -- force_close | lifecycle_timeout | backfill | discovered.
  reason TEXT NOT NULL,
  enqueuedAt INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Never retry before this. Bounded backoff; a permanently failing event must not spin.
  nextAttemptAt INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  -- Set when the seal lands. The row is KEPT rather than deleted so the operational history
  -- of what was sealed, when, and after how many attempts survives the work itself.
  sealedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_seal_pending_open ON seal_pending (sealedAt, nextAttemptAt);
