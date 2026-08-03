-- Brief 41 §D / Brief 35 Fix B acceptance 12 — CROSS-ISOLATE DETECTION OF A TARGETED ATTACK.
--
-- The limiter counts in isolate memory, which is right for §E4: rejecting a flood must be cheaper
-- than serving it, and an in-memory bucket costs nothing. But it made §D's most important signal
-- unreachable. Acceptance 12 proved it: 26 rapid attempts against one identifier on production
-- produced 16 rejections and ZERO sustained-limiting alerts, because the requests were spread
-- across isolates and no single bucket ever passed the error threshold.
--
-- "Sustained limiting on one identifier is a targeted attack on a specific survivor, not
-- background noise." A signal that only fires when an attacker happens to stay on one colo is not
-- that signal.
--
-- So a REJECTED request — and only a rejected one — records itself here. The normal path still
-- touches no database: this write happens after the decision to refuse, so the cost lands on the
-- attacker's request, exactly as the canary exemption lookup does.
CREATE TABLE IF NOT EXISTS limit_events (
  identifier TEXT NOT NULL,
  rule       TEXT NOT NULL,
  createdAt  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_limit_events_id ON limit_events (identifier, rule, createdAt);
CREATE INDEX IF NOT EXISTS idx_limit_events_at ON limit_events (createdAt);
