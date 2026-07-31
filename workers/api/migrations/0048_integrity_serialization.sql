-- BLACK BOX backend schema v48 — integrity chain: serialize appends, never conceal a
-- collision (Brief 37).
--
-- THE DEFECT. `appendToChain` read the head, computed seq+1, then issued a D1 batch. The
-- batch is transactional; the READ was outside it. Two overlapping requests for one event
-- both read seq=5, both compute 6, and both write: A inserts record 6A and sets head 6A;
-- B's `INSERT OR IGNORE` is silently dropped while its head upsert still lands. The signed
-- head then names a record that does not exist. No attacker required — chunks and
-- commitments are independent HTTP requests and overlap is the normal case, so an ordinary
-- capture produced an unverifiable export.
--
-- Serialization itself is structural (a per-event Durable Object, see src/integrity-do.ts)
-- and needs no schema. These two tables exist for the things that CANNOT be solved by
-- ordering alone.
--
-- integrity_gaps — §B. A failed append must never fail the capture: losing evidence to
-- protect a hash chain inverts the priority. But a chain that silently comes up short is
-- worse than one that admits it, so a dropped append is RECORDED, and the verifier reports
-- INCOMPLETE naming the sequence rather than quietly producing a shorter chain that still
-- looks internally consistent. The gap is the honest artifact of the trade.
--
-- integrity_idempotency — §C. The serialization point is the only place replay protection
-- can live, so the surface is built here even though the credential that uses it arrives in
-- Brief 42. A repeated key returns the ORIGINAL result and appends nothing. Scoped to the
-- event and deleted with it (see lib/users.ts byEvent list) so keys expire with their event.

CREATE TABLE IF NOT EXISTS integrity_gaps (
  eventId TEXT NOT NULL,
  -- The head sequence at the moment the append failed: the chain is complete up to and
  -- including this seq, and is missing at least one record after it.
  seq INTEGER NOT NULL,
  recordType TEXT NOT NULL,
  recordRef TEXT NOT NULL,
  reason TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (eventId, recordRef)
);

CREATE INDEX IF NOT EXISTS idx_integrity_gaps_event ON integrity_gaps (eventId, seq);

CREATE TABLE IF NOT EXISTS integrity_idempotency (
  eventId TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL,
  -- The result of the ORIGINAL append, returned verbatim on replay.
  seq INTEGER NOT NULL,
  chainHash TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (eventId, idempotencyKey)
);
