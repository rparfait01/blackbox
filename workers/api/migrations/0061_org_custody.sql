-- Brief 53 §C — THE ORG HALF OF ZERO-KNOWLEDGE CUSTODY. SHIPS DARK.
--
-- ═══ WHAT WAS ALREADY BUILT, SO THIS IS NOT MISREAD AS THE WHOLE THING ═══════════════════════
--
-- Briefs 36–39 built the SURVIVOR half and it is live: per-capture random DEK sealed on-device,
-- AAD binding capture id ‖ chunk index ‖ final flag, counter-based IV (4-byte random prefix ‖
-- 8-byte chunk counter — review Q4 is SATISFIED as shipped, no correction owed to Brief 36 §A),
-- signed pre-encryption plaintext commitments, and a server holding ciphertext, hash and wrapped
-- keys only. 0034 already carries `wrapped_keys` (DEK wrapped per recipient, with `algId` per row
-- so X25519 is a config change) and `org_key_grants` (the org private key wrapped once per seat,
-- N copies, no plaintext column anywhere).
--
-- This migration adds the four things that were genuinely absent.
--
-- ═══ IT IS DARK, AND §C4 IS WHY ══════════════════════════════════════════════════════════════
--
-- Brief 26 §5 requires two gates that are not paperwork and are both UNMET:
--
--   1. Independent crypto review of the primitives and envelope design.
--   2. Legal review of chain of custody — whether re-encrypted evidence is admissible.
--
-- Perfect cryptography is not admissible evidence. Nothing here is reachable until both clear;
-- the tables exist so the code that fills them can be written and tested, not because anything
-- is switched on. `org-custody-dark.guard.test.ts` fails if the flag defaults on.
--
-- ═══ THE TWO POWERS, NEVER ONE PERMISSION CHECK (§C5.4) ══════════════════════════════════════
--
-- The ORG KEY OPERATES. The SURVIVOR'S AUTHORITY RELEASES. A seat holding the org key can read
-- what the org already holds; it cannot hand that content to a third party. Release is a separate
-- table with a separate authorization, and the two are never collapsed into one check.

-- ── 1. SEAT OFFBOARDING: THE SIGNED ROTATION EVENT (§C2, state 8) ────────────────────────────
--
-- The re-wrap itself already exists (POST /v1/org/keys sets a new generation carrying a grant for
-- every remaining seat). What was missing is the RECORD: who rotated, why, which generation
-- replaced which, and a signature from the performing seat so the event cannot be forged by the
-- server that stores it.
--
-- The rotation is performed CLIENT-SIDE by a remaining authorized seat. The server cannot do it —
-- it has no plaintext org key to re-wrap, which is the entire point — so this table records an
-- act it witnessed rather than one it performed.
CREATE TABLE IF NOT EXISTS org_key_rotations (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  fromGeneration INTEGER NOT NULL,
  toGeneration INTEGER NOT NULL,
  -- Why. 'seat_offboarded' is the case this exists for; a scheduled rotation is also legitimate.
  reason TEXT NOT NULL CHECK (reason IN ('seat_offboarded', 'scheduled', 'suspected_compromise')),
  -- The seat that PERFORMED it, and the seat that left (null for a scheduled rotation).
  performedBySeatId TEXT NOT NULL,
  departedSeatId TEXT,
  seatsRewrapped INTEGER NOT NULL DEFAULT 0,
  -- Signed by the performing seat over the canonical rotation record. The server verifies against
  -- that seat's registered public key and stores the signature for later audit; it cannot mint one.
  signature TEXT,
  signatureAlgId TEXT,
  -- Chain linkage: this event is appended to the event-independent org custody chain.
  chainHash TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_rotations_org ON org_key_rotations (orgId, createdAt);

-- ── 2. RELEASE (§C2, state 7) ────────────────────────────────────────────────────────────────
--
-- The survivor authorizes; the content is re-encrypted to the NAMED RECIPIENT's key; the
-- provisioning is logged. Never a download-and-forward, and never a standing copy — a release is
-- to one named recipient for one purpose, and the row says which.
--
-- `authorizedByUserId` is the SURVIVOR, never a seat. A release with no survivor authorization is
-- not expressible: the column is NOT NULL, so the unsafe state cannot be stored.
CREATE TABLE IF NOT EXISTS release_grants (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  orgId TEXT,                          -- NULL when an unaffiliated survivor releases directly
  authorizedByUserId TEXT NOT NULL,    -- THE SURVIVOR. Not the org, not a seat.
  recipientLabel TEXT NOT NULL,        -- who it went to, in words a court can read
  recipientPubkey TEXT NOT NULL,       -- the key it was re-encrypted to
  algId TEXT NOT NULL,
  purpose TEXT,
  -- Re-encrypted DEK, sealed to the recipient. The server never holds the plaintext DEK.
  wrappedDek TEXT NOT NULL,
  -- A release is scoped in time and revocable going forward. §C3 says plainly that revocation
  -- cannot un-see what was already read; this is the forward-facing half, honestly labelled.
  expiresAt INTEGER,
  revokedAt INTEGER,
  revokedReason TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_release_event ON release_grants (eventId, createdAt);
CREATE INDEX IF NOT EXISTS idx_release_org ON release_grants (orgId);

-- ── 3. WATERMARKING (§C2) ────────────────────────────────────────────────────────────────────
--
-- A capture decrypted by a seat carries account, org and seat identifiers so a leak traces back to
-- a seat. This is the control that actually works, and §C3 requires saying so: re-wrapping on
-- offboarding stops FUTURE server-mediated access and cannot un-see what a seat already saw.
-- Retroactive revocation is partly theater. Watermarking and audit are the real deterrent.
--
-- One row per decrypt, not per capture: the question a leak investigation asks is "who opened
-- this", and that is a log, not a property of the object.
CREATE TABLE IF NOT EXISTS capture_access_log (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  sequence INTEGER,                    -- NULL = whole-capture access (an export)
  orgId TEXT,
  seatUserId TEXT NOT NULL,            -- WHO opened it
  keyGeneration INTEGER,
  -- The watermark embedded in what the seat received, so a leaked file names its reader.
  watermark TEXT NOT NULL,
  accessKind TEXT NOT NULL CHECK (accessKind IN ('decrypt', 'export', 'release')),
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_access_event ON capture_access_log (eventId, createdAt);
CREATE INDEX IF NOT EXISTS idx_capture_access_seat ON capture_access_log (seatUserId, createdAt);

-- ── 4. LOCATION WRAPPED TO THE ORG (§C2, decision B) ─────────────────────────────────────────
--
-- Location points are currently server-plaintext in `locations_index`. Decision B says they are
-- wrapped like capture content — same envelope, same recipients — so the server holds ciphertext.
--
-- THIS TABLE DOES NOT REPLACE `locations_index` AND MUST NOT, YET. The live alert path reads
-- plaintext location to render a responder's map DURING an incident, and a survivor mid-event is
-- not the person to discover an encryption migration. Both exist; the cutover is a separate,
-- flagged step after §C4 clears, and it is called out here so a later reader does not assume the
-- plaintext table is dead.
CREATE TABLE IF NOT EXISTS wrapped_locations (
  id TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  orgId TEXT,
  algId TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,            -- the sealed point; no lat/lon column exists here
  recordedAt INTEGER NOT NULL,         -- when the point was taken (not the content)
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wrapped_loc_unique ON wrapped_locations (eventId, sequence);
CREATE INDEX IF NOT EXISTS idx_wrapped_loc_org ON wrapped_locations (orgId);
