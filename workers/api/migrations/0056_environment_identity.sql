-- Brief 35 Fix B §A — WHICH ENVIRONMENT IS THIS, ASKED OF THE BOUND RESOURCE ITSELF.
--
-- Staging holds a live SENDGRID_API_KEY. Whether it draws on a separate SendGrid account from
-- production is unknown, and this project has already had a real 05:21 alert reach nobody after
-- test sends drained the credits. So there are two live failure modes right now: a staging send
-- reaching a real inbox, and staging sends consuming the credits a production cascade depends on.
--
-- WHY A ROW IN D1 AND NOT A VAR. §A requires the environment be DERIVED, never configured — "from
-- the Worker's own binding set, the same way the R2 authority rule works". A var can be omitted by
-- a deploy, overridden by `--var`, or copied between environments; a hostname can be spoofed by a
-- route. This marker lives INSIDE the database the binding points at, so a Worker wired to
-- blackbox-test reads 'staging' no matter what its vars, its hostname, or its deploy command say.
-- To make staging dispatch you would have to point it at the production database, at which point
-- it IS production by every measure that matters.
--
-- The value is deliberately NOT seeded here. A shared migration runs identically against both
-- databases and could only insert the same answer into each, which would be a configured value
-- wearing a migration's clothes. Each database is stamped once, explicitly, through the admin
-- endpoint — and an UNSTAMPED database resolves INDETERMINATE, which per §B dispatches and alerts
-- rather than suppressing. The direction of that default is the whole point: the failure that
-- matters is not a leaked staging email, it is production silently deciding it is not production
-- and swallowing a real cascade.
CREATE TABLE IF NOT EXISTS environment_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL,
  stampedAt  INTEGER NOT NULL,
  stampedBy  TEXT
);
