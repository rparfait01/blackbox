-- BLACK BOX backend schema v47 — encryption state, observed by the server (Brief 36).
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS. ENVELOPE_ENCRYPTION_ENABLED has been "armed" since
-- 2026-07-30. On the day this migration was written production held 62 capture chunks,
-- 0 wrapped_keys, 0 plaintext_commitments and 0 accounts with a pubkey. Not one byte was
-- ever encrypted. The deployment described itself as encryption-armed and the schema had
-- no way to contradict it, because nothing recorded what state a chunk was actually in.
--
-- So the point of these columns is not encryption. It is HONESTY: after this, the
-- difference between "encrypted", "unencrypted and said so", and "unencrypted and did not
-- say so" is a value you can query, and the third case — the original defect, silent
-- plaintext — is the one that raises an alert.
--
-- chunks_index.encryptionState — SERVER-OBSERVED, never a client assertion. Derived by
-- inspecting the bytes that arrived (envelope frame header + a well-formed plaintext
-- commitment) rather than by believing a header. A client that lied, or that was simply
-- wrong, cannot make an unencrypted chunk record as encrypted.
--
--   ENCRYPTED               the frame and commitment are present and well-formed
--   UNENCRYPTED_DECLARED    plaintext, and the client said so (FAILED_TERMINAL) — a
--                           legitimate, surfaced, alerted state; Brief 26's fail-open
--                           rule survives, it just no longer happens quietly
--   UNENCRYPTED_UNDECLARED  plaintext with no declaration — THE DEFECT. Alertable.
--
-- users.encryptionPolicy — REQUIRED by default per §E. NOTE that the default is the
-- POLICY, not the enforcement: rejecting a non-conforming chunk is gated separately by the
-- ENCRYPTION_ENFORCED var, which is OFF. Shipping the policy armed and the enforcement
-- dark is deliberate — arming is Brief 47's acceptance, and until it is green no document
-- may state that capture is encrypted.
--
-- events.* — frozen per capture so the report can state which policy applied and which
-- state was reached, rather than re-deriving it later from whatever is true then.
--
-- Every column defaults to a value that changes nothing for existing rows.

ALTER TABLE chunks_index ADD COLUMN encryptionState TEXT NOT NULL DEFAULT 'UNENCRYPTED_UNDECLARED';

ALTER TABLE users ADD COLUMN encryptionPolicy TEXT NOT NULL DEFAULT 'REQUIRED';

-- The policy in force when the capture opened, and the terminal encryption state the
-- capture reached. Null until the client reports; the report says so rather than guessing.
ALTER TABLE events ADD COLUMN encryptionPolicy TEXT;
ALTER TABLE events ADD COLUMN encryptionState TEXT;

-- §D — capture-level safety degradation, DISTINCT from encryption state. Encryption state
-- says whether bytes can be protected; this says whether they are being retained at all.
-- NONE | EVIDENCE_AT_RISK | EVIDENCE_NOT_RETAINED.
ALTER TABLE events ADD COLUMN degradationState TEXT;

-- The readiness panel counts plaintext chunks; the alert path counts undeclared ones.
CREATE INDEX IF NOT EXISTS idx_chunks_encstate ON chunks_index (encryptionState);

-- §G — MAKE THE UNSAFE STATE UNREPRESENTABLE, not merely improbable.
--
-- Brief 35's suppression needs both events.isTest and users.isCanary, which is tight
-- against a stray isTest and was NOT tight against a stray isCanary: one UPDATE promoting
-- a real account would make its alerts suppressible. isCanary is now write-once at
-- provisioning and immutable thereafter — the database itself refuses the change, so it
-- cannot be done by a bug, a console session, or a well-meaning script. A legitimate
-- change requires a migration, which is tracked, reviewed and named by construction.
CREATE TRIGGER IF NOT EXISTS trg_users_iscanary_immutable
BEFORE UPDATE OF isCanary ON users
FOR EACH ROW WHEN OLD.isCanary <> NEW.isCanary
BEGIN
  SELECT RAISE(ABORT, 'isCanary is immutable after provisioning (Brief 36 §G)');
END;
