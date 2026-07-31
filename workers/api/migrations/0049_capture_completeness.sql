-- BLACK BOX backend schema v49 — capture completeness (Brief 38).
--
-- THE DEFECT. `sendItem()` called `sealChunkForSend()` with `isFinal: false` on every chunk
-- without exception. `X-Is-Final` was therefore never 1, every row got isFinal=0, and report
-- generation always answered `finalChunkPresent: false`. The schema column, the header, the
-- AAD field and the report field all existed; nothing ever produced the value.
--
-- So EVERY REAL CAPTURE APPEARED TRUNCATED. A capture that ended normally and a capture whose
-- tail was silently lost were indistinguishable by the exact mechanism built to tell them
-- apart, and the documented admissibility property did not function.
--
-- events.completenessState — the per-capture answer, and it is ORTHOGONAL to Brief 37's chain
-- outcome. Chain integrity asks "is the record trustworthy"; completeness asks "did the
-- recording end normally". A purged capture keeps the completeness state it held at purge, so
-- the export renders both axes and neither can be mistaken for the other.
--
--   IN_PROGRESS               the capture is live (the default at creation)
--   COMPLETE                  normal stop, authenticated terminal marker, ordering intact
--   COMPLETE_UNAUTHENTICATED  normal stop under Brief 36 FAILED_TERMINAL: the marker is
--                             present and true, but the chunk had no envelope so the marker
--                             could not be authenticated
--   ABNORMAL                  ended without a normal stop
--
-- ABNORMAL IS NOT A DEFECT, and this is the whole reason the state is modelled rather than
-- inferred from a missing marker. A device seized, destroyed, or with its battery pulled
-- mid-event IS the threat model. A survivor whose phone was taken has not produced defective
-- evidence, and a verifier that reports her capture as damaged or tampered would be actively
-- harmful in the moment it matters most. It is set BY THE SERVER on lifecycle timeout or
-- heartbeat loss — never by the device, because the device is the thing that stopped.

ALTER TABLE events ADD COLUMN completenessState TEXT NOT NULL DEFAULT 'IN_PROGRESS';

-- The last sequence the server actually received, frozen when the capture is declared
-- ABNORMAL, so the report can say "segments through sequence N are present" rather than
-- leaving the survivor to guess how much was saved.
ALTER TABLE events ADD COLUMN lastSequenceReceived INTEGER;

-- Why the terminal marker is where it is: 'flush' (the recorder's own final payload) or
-- 'no_trailing_payload' (the stop produced nothing, so the preceding chunk is terminal).
ALTER TABLE chunks_index ADD COLUMN terminalReason TEXT;

CREATE INDEX IF NOT EXISTS idx_events_completeness ON events (completenessState);
