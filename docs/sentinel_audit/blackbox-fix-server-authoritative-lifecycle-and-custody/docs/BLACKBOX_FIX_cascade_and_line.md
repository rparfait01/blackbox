# BLACK BOX — Fix: Cascade timing + LINE delivery (P0)

STANDING RULES apply (surgical changes only; full flow re-proven both modes before "done";
no silent failures; prove on the DEPLOYED app with real responses, not "tests pass").

Two failures, likely one root cause: things that should fire after contact 1 don't. If the
scheduler dies after the first send, contacts 2–4 never attempt their channels — so "only
contact 1 fired" and "LINE never fires" may be the same break. Trace them together.

## Required cascade timing — measured from the trigger instant (T+0), full chain under 60s
- Contact 1 (primary):   T+0s
- Contact 2 (secondary): T+10s
- Contact 3 (tertiary):  T+20s
- Guardian (4):          T+30s (no later)
- Emergency (if populated): T+40s (no later)

## Do this in order
1. **Trace one real trigger end to end with timestamps.** For every populated step log:
   scheduled time, actual fire time, channel, and the literal send response. Only contact 1
   is firing — find exactly where the chain stops, and capture what the LINE Messaging API
   actually returns when LINE is attempted.
2. **Diagnose (check in order):**
   (a) Is the scheduler/cron that fires steps 2 → emergency actually running and being
       scheduled after the first send, or does the cascade halt after contact 1?
   (b) When LINE is attempted, what does the LINE API return — 200 / 4xx / token error /
       non-follower? My userId is valid and I'm a follower, so the failure is in the send
       path, the token, or a regression in the LINE branch.
   (c) Did the recent slots/contacts changes break the LINE sender or the scheduler the way
       they broke email before? Bisect the last several commits.
3. **Fix both at the root:**
   - All populated steps fire on schedule: T+0 / +10 / +20 / ≤+30 / ≤+40.
   - A failed send or missing channel on ANY step must NOT stop the later steps — the
     schedule keeps advancing no matter what.
   - LINE delivers a real message to my userId. If LINE can't deliver, that step still must
     not halt the cascade, and the failure must surface (in-app + audit), never silent.
4. **Prove on the deployed app with ONE real timed run:** trigger once, paste the actual fire
   timestamps for every populated step showing 1 → 2 → 3 → guardian (→ emergency) landing in
   their windows, AND a real LINE message confirmed delivered to my userId (LINE API 200 +
   it actually arriving). Not "configured," not "tests pass" — the real timed sequence with
   real delivery on every channel.
