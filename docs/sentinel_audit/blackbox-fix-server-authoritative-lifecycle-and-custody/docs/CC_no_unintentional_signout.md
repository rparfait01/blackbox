# CC — NO UNINTENTIONAL SIGN-OUT (safety rule)

**A survivor silently logged out has a dead safety device and doesn't know it. Session persists until the user
explicitly signs out. Enforce ALL of these; prove on the real surface.**

Standing constraints apply. §0a byte-identical, safety floor untouched, both halves currency-asserted.

1. **No timed expiry.** No idle timeout, no max-age logout, no "session expired" forcing re-auth. Session lives
   until explicit sign-out.
2. **Survives everything except sign-out:** app close, device restart, backgrounding, network loss, offline
   periods, PWA update / service-worker refresh. Reopening never lands on sign-in unless the user signed out.
3. **Silent auto-refresh.** If the session uses any expiring token, it refreshes in the background — never
   bounces the user to sign-in.
4. **Sign-out is the ONLY thing that ends a session.** Not an error, not a failed request, not a 401, not a
   retry, not clearSession invoked by another flow. Audit every code path that clears the session and confirm
   only the explicit Sign-out control reaches it.
5. **Failure degrades to cached-signed-in, never to logged-out.** A failed/expired server check retries or falls
   back to cached session state — losing the network is never losing the session. (This is the class that
   stranded a user before.)

## ACCEPTANCE
- `[L]` Sign in → close app → reopen → still signed in.
- `[L]` Sign in → restart device → reopen → still signed in.
- `[L]` Sign in → go offline → wait → reopen → still signed in, armed, trigger works.
- `[L]` Sign in → force a service-worker/PWA update → still signed in.
- `[L]` Sign in → force a server 401 / failed session check → NOT logged out; degrades to cached state.
- `[L]` Only the explicit Sign-out control ends the session — proven by auditing every session-clearing path.

## NOTE (accepted trade)
Never-expiring passwordless session means a found/unlocked device stays signed in. For this threat model that's
the correct trade — silent logout of a survivor's safety device is worse than device-theft risk, which the
covert facade + physical-device assumptions already cover. Record this in code comments alongside the rule.
