-- BLACK BOX backend schema v9 (Fix Brief 3). Coordinator claim on the live
-- guardian path: the FIRST guardian to open the notification link becomes the
-- coordinator (full live access); later guardians get the notified (limited)
-- view. The coordinator is recognized on return by a cookie matching
-- coordinatorKey. UTC canonical (#C6).

ALTER TABLE events ADD COLUMN coordinatorClaimedAt INTEGER; -- UTC ms first claim
ALTER TABLE events ADD COLUMN coordinatorKey TEXT;          -- random; matched against the bbcoord cookie
