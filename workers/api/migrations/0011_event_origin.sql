-- BLACK BOX backend schema v11 (Fix Brief 5 D1). Frozen ORIGIN snapshot — the
-- immutable "initial contact" anchor captured at activation. Write-once: one row
-- per event, never updated as the event evolves. Canonical UTC + offset (#C6).

CREATE TABLE IF NOT EXISTS event_origin (
  eventId TEXT PRIMARY KEY,             -- one per event; INSERT OR IGNORE = write-once
  triggerType TEXT NOT NULL,            -- 'manual' | 'deadman' | 'tamper'
  dtgStart INTEGER NOT NULL,            -- UTC ms of activation (t=0)
  tzOffsetMinutes INTEGER,
  lat REAL,                             -- initial location (nullable)
  lon REAL,
  accuracyM REAL,
  audioFromSeq INTEGER,                 -- first ~10-15s of audio: chunk range
  audioToSeq INTEGER,
  initialCategoriesJson TEXT,           -- first detected keyword categories (JSON array)
  initialThreatLevel TEXT,              -- first deterministic threat level
  initialVoiceCount INTEGER,            -- distinct voices detected at origin (light diarization)
  createdAt INTEGER NOT NULL            -- when the snapshot row was written
);
