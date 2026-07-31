-- BLACK BOX backend schema v46 — the deploy canary, and its isolation (Brief 35 §C/§D).
--
-- WHY A CANARY EXISTS AT ALL. Matching build ids proved that the PWA and the Worker came
-- from one commit. It proved nothing about whether the client could REACH the server, and
-- the product spent its whole life one clean checkout away from publishing a build that
-- could not: `.env` is gitignored, the empty-origin fallback disabled the entire upload /
-- event / heartbeat pipeline, and every symptom was invisible from the device. The only
-- honest proof that the alert path exists is a transaction that actually completes against
-- production. That is what these two columns make safe to run.
--
-- users.isCanary — the identity. SERVER-SET ONLY. There is no request body, query
-- parameter or header anywhere in the Worker that writes it; it is set by the ADMIN-gated
-- provisioning route (POST /v1/admin/canary/provision) and by nothing else. A survivor's
-- account can never acquire it by asking.
--
-- events.isTest — DERIVED, never accepted. Stamped at event creation from the owning
-- account's isCanary, in the same statement that creates the event. A client-supplied
-- `isTest` in the body is ignored — see the §D regression guard, which fires an alert on a
-- real account and proves it dispatches normally.
--
-- THE HAZARD THIS COLUMN CREATES, AND HOW IT IS CONTAINED. `isTest` exists to make a code
-- path that DELIBERATELY DOES NOT DELIVER. Brief 31 rejected exactly this shape for the
-- acceptance suite, and was right to: a flag that suppresses delivery is one bad UPDATE
-- away from swallowing a real survivor's alert. So suppression does not trust this column
-- on its own. The router re-derives ownership at dispatch time and suppresses only when
-- the event is flagged AND its owner is still a canary account. A flag found on a
-- non-canary account DISPATCHES NORMALLY and raises an alertable operator condition —
-- fail-safe in the direction that costs a test, never a life.
--
-- Both default to 0, so every existing row — 4,002 chunks, every live account, every past
-- event — is unflagged and unaffected. Nothing about this migration changes behaviour for
-- any existing account.

ALTER TABLE users ADD COLUMN isCanary INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN isTest INTEGER NOT NULL DEFAULT 0;

-- The TTL sweep (scheduled.ts) and the purge both scan for flagged events by age. Partial
-- index: it covers only canary rows, so it costs nothing on the real-event path.
CREATE INDEX IF NOT EXISTS idx_events_test ON events (isTest, createdAt) WHERE isTest = 1;

-- Aggregate counters, exports and dashboards filter on isTest = 0. Real events are the
-- overwhelming majority, so this index exists for the canary side only.
CREATE INDEX IF NOT EXISTS idx_users_canary ON users (isCanary) WHERE isCanary = 1;
