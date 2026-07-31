-- BLACK BOX backend schema v50 — backfill capture completeness (Brief 38).
--
-- 0049 added `completenessState` with a default of 'IN_PROGRESS', which is correct for a
-- capture that is about to start and WRONG for every capture that had already finished. The
-- first read across production showed five long-closed events reporting "Capture in
-- progress." — a false sentence in a report, about evidence, produced by a default rather
-- than by anything that happened.
--
-- This is the same shape as migration 0038, which silently un-armed every account: a new
-- column whose default quietly asserts something untrue about existing rows. A default is
-- not a backfill.
--
-- The honest state for these captures is ABNORMAL. They ended without a normal stop and no
-- terminal marker was ever produced — not because anything failed, but because the mechanism
-- that produces one did not exist when they ran. ABNORMAL is a factual outcome, not a defect
-- (Brief 38 §D), so this records what is true rather than flattering the record.
--
-- `lastSequenceReceived` comes from the integrity chain rather than chunks_index, because
-- these events' objects were purged on recorded owner consent at 13c539f while their chain
-- records were deliberately kept. The chain still knows how many segments existed, which is
-- exactly the question the report needs answered.

UPDATE events
   SET completenessState = 'ABNORMAL',
       lastSequenceReceived = COALESCE(
         (SELECT MAX(sequence) FROM chunks_index c WHERE c.eventId = events.id),
         (SELECT COUNT(*) - 1 FROM integrity_records r WHERE r.eventId = events.id AND r.recordType = 'chunk'),
         NULL
       )
 WHERE status = 'closed'
   AND completenessState = 'IN_PROGRESS';
