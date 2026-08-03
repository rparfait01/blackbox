-- Brief 50 §C — TRANSCRIPTION FAILURE IS DECLARED, NOT SILENT.
--
-- The observed failure: Visible mode captured audio and produced no transcript and no summary,
-- and the coordinator's panel showed "Listening…" throughout. A blank transcript panel does not
-- read as "we could not transcribe." IT READS AS NOTHING WAS SAID — at the one moment that
-- distinction decides whether someone comes.
--
-- The client is the only party that knows: Web Speech runs on the device, and its failure is
-- invisible to the server, which simply receives no fragments. Zero fragments is ambiguous
-- between "silence", "not transcribing" and "not yet" — so the device reports which.
--
-- NULL means not yet reported, and the surface says so rather than guessing. Recording is never
-- gated on this: transcription is not a precondition for capture and must never become one.
ALTER TABLE events ADD COLUMN transcriptionState TEXT
  CHECK (transcriptionState IS NULL OR transcriptionState IN ('active', 'degraded', 'unavailable'));
ALTER TABLE events ADD COLUMN transcriptionDetail TEXT;
