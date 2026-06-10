-- BLACK BOX backend schema (W5). Metadata only; media bytes live in R2.

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  status TEXT NOT NULL,          -- active | closed | interrupted
  userHash TEXT NOT NULL,        -- sha256 of the local device UUID
  hmacSecret TEXT NOT NULL,      -- per-event signing secret
  source TEXT,
  closedAt INTEGER,
  closedBy TEXT
);

CREATE TABLE IF NOT EXISTS chunks_index (
  eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  r2Key TEXT NOT NULL,
  sizeBytes INTEGER NOT NULL,
  mimeType TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (eventId, sequence)
);

CREATE TABLE IF NOT EXISTS locations_index (
  eventId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  accuracyM REAL,
  speed REAL,
  PRIMARY KEY (eventId, timestamp)
);

CREATE TABLE IF NOT EXISTS classifications_index (
  eventId TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  threatLevel TEXT,
  matchedCategoriesJson TEXT,
  toneIndicatorsJson TEXT,
  summaryText TEXT,
  languagesJson TEXT,
  PRIMARY KEY (eventId, timestamp)
);

CREATE TABLE IF NOT EXISTS transcripts_index (
  eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  text TEXT NOT NULL,
  isFinal INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (eventId, sequence)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  eventId TEXT,
  action TEXT NOT NULL,
  actorHash TEXT,
  timestamp INTEGER NOT NULL,
  metadataJson TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log (eventId);
