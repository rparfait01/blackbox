-- Brief 41 §C — the outbound cap that abuse cannot use to starve the alert path.
--
-- Brief 31 decoupled the acceptance suite from the SendGrid quota. An unauthenticated attacker
-- could still drain it — hammer /v1/auth/magic/start and every real alert afterwards reaches
-- nobody. That is an attack that takes the alert path down without ever touching the alert path,
-- and it has a precedent in this system: a real 05:21 alert once reached nobody because test runs
-- had drained the quota first.
--
-- Counted in D1 rather than isolate memory because a provider quota is GLOBAL: an attacker
-- distributed across colos must still hit one ceiling. Only NON-ALERT sends are recorded here.
-- Alert-path messages are never inserted and never consulted, so no volume of abuse can reduce
-- the allocation available to a survivor's cascade.
CREATE TABLE IF NOT EXISTS outbound_attempts (
  identifier TEXT NOT NULL,
  createdAt  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_attempts_id ON outbound_attempts (identifier, createdAt);
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_at ON outbound_attempts (createdAt);
