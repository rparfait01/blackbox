-- Brief 33 Fix B §A/§B — GET THE COORDINATOR'S TOKEN OUT OF THE ADDRESS BAR.
--
-- ═══ THE EXPOSURE ════════════════════════════════════════════════════════════════════════════
--
-- The dashboard is reached at `/c/:id?t=<token>`. Brief 42 chose `Referrer-Policy: no-referrer`
-- to stop that URL leaking outward, and it does. It does nothing about the URL itself, which
-- lands in browser history, address-bar autocomplete, cross-device sync, and any screenshot or
-- shoulder-glance.
--
-- The coordinator is typically the survivor's closest contact, plausibly on a shared device,
-- plausibly in the same household as the person the alert is about. `blackbox…/c/<event>` sitting
-- in a history list discloses that an alert happened, to whoever opens that browser next.
--
-- It is worse than the address bar alone: EVERY dashboard API call and the WebSocket URL carry
-- `?t=` too (page.ts), so the token is in every request line and every proxy log as well.
--
-- ═══ WHAT REPLACES IT ════════════════════════════════════════════════════════════════════════
--
-- A view session. The first request exchanges the tokened URL for an HttpOnly cookie and is
-- redirected to a bare `/c/:id`; everything after that is cookie-borne. An HTTP redirect leaves
-- only the destination in history, so the tokened URL never enters the back stack — and it needs
-- no JavaScript, no interstitial, and no extra tap, which §0 makes non-negotiable.
--
-- ═══ WHY A TABLE AND NOT A SIGNED COOKIE ═════════════════════════════════════════════════════
--
-- §B requires that re-presenting the same token from the SAME browser succeeds while a different
-- browser presenting a spent token is refused. That is a statement about which browser redeemed,
-- and a self-contained signed cookie cannot answer it — the server has to remember.
--
-- ═══ REDEMPTION IS NOT CLAIM (§E3) ═══════════════════════════════════════════════════════════
--
-- Brief 7 locked coordinator claim to an explicit POST because merely opening a link must never
-- claim coordination — duress would route to whoever opened first. Nothing here claims anything.
-- A view session lets someone SEE the event; `coordinatorClaimedAt` and the `bbcoord` cookie are
-- untouched and still require the deliberate "Take coordination" POST.

CREATE TABLE IF NOT EXISTS coordinator_view_sessions (
  -- The `bbview` cookie value. Random, opaque, and never derived from the token — a session id
  -- that a token could reproduce would just be the token again under another name.
  sessionKey TEXT PRIMARY KEY,
  eventId TEXT NOT NULL,
  -- SHA-256 of the magic token that minted this session. The token itself is never stored: this
  -- table would otherwise be a list of live credentials for every open event.
  tokenHash TEXT NOT NULL,
  role TEXT NOT NULL,
  -- Set when a HUMAN redeemed through this session (§B). NULL means the link was fetched but
  -- never demonstrably opened by a person — a link-scanner prefetch leaves exactly this state,
  -- and an unredeemed token stays usable by anyone, which is the fail-open direction.
  redeemedAt INTEGER,
  createdAt INTEGER NOT NULL,
  lastSeenAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_coord_view_event ON coordinator_view_sessions (eventId);
-- The lookup that answers "has a human already bound this link, and to which browser?"
CREATE INDEX IF NOT EXISTS idx_coord_view_token ON coordinator_view_sessions (tokenHash, redeemedAt);
