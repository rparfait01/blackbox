# BRIEF 42 — SECURITY HEADERS AND SESSION ROTATION

**Type:** BUILD — no prior brief shipped headers or rotation
**Priority:** P2
**REQUIRES:** Brief 36 Fix A green (§E1 tests offline capture under CSP, which needs the queue
bounded); Brief 41 green (§C rotation interacts with the limiter's session keying).
**Ship order:** EIGHTH.
**Floor:** Briefs 35–41, Brief 36 Fix A. **Zero regression to the §0a Hidden facade** — a CSP
that alters Stillpoint's rendering breaks covert mode and fails this brief.
**Audit ref:** Pass 1 Finding 12 · Pass 2 Finding 12 (Confirmed — P2)

---

## THE DEFECT

The PWA is served without a content-security policy or the standard transport and framing
headers. Sessions are not rotated at privilege transitions, so an identifier captured before
authentication or before a role change remains valid after it.

For this product the CSP matters more than P2 suggests: an injected script in the facade can read
capture state, reveal covert mode, or suppress a trigger.

---

## §A — CSP

- Explicit policy. No `unsafe-inline`, no `unsafe-eval`. Nonces or hashes where inline is
  unavoidable.
- **Report-only first**, over real use in both Present modes, then enforce. Never enforce blind —
  a CSP that breaks the facade in Hidden is a covert-mode failure discovered by a survivor.
- `frame-ancestors` denies embedding.

## §B — TRANSPORT AND FRAMING

HSTS with a stated max-age, `X-Content-Type-Options: nosniff`, a referrer policy that leaks no
path, and a permissions policy granting only microphone, camera, geolocation.

## §C — SESSION ROTATION

- Rotate on every privilege transition: anonymous → authenticated, passkey registration, role
  change, org membership change (Brief 23 Fix A), operator elevation.
- Old identifier invalid immediately.
- **Rotation must not disturb an active alert.** Rotate mid-event; confirm the event stays live
  and the cascade continues.

## §D — COORDINATOR SURFACES

`/v1/c/*` runs on magic tokens and the `bbcoord` cookie. Verify `HttpOnly`, `Secure`, `SameSite`,
and that the referrer policy prevents the event-bound token leaking from the dashboard.

## §E — ANTICIPATED GAPS

1. **Service worker under CSP.** The PWA registers a service worker; a restrictive `worker-src`
   or `script-src` breaks registration and therefore offline capture. Test offline capture under
   enforcement, not only page load.
2. **Report-only reporting endpoint costs requests.** Route violation reports to a bounded
   endpoint with sampling, or collect from the browser console during a controlled pass. Do not
   open an unbounded reporting firehose on a metered Worker.
3. **HSTS is hard to reverse.** State the max-age and whether preload is requested. Do not
   preload a domain still under active development.
4. **The facade is the acceptance criterion.** Hidden mode must render byte-identically before and
   after. Diff it, do not eyeball it.

---

## ACCEPTANCE

1. Headers present on every served route. Show the response.
2. Report-only pass over both Present modes with real use → zero violations before enforcing.
3. Enforced CSP: **facade renders byte-identically in Hidden.** Diff, both modes screenshotted.
4. Service worker registers under enforcement; offline capture works.
5. Trigger, capture, closure, cascade, coordinator dashboard all function under enforcement.
6. Session rotates at each named transition; old identifier rejected.
7. **Rotate mid-alert → event stays live, cascade continues.** Screenshot.
8. Coordinator cookie attributes verified; no token in referrer.
9. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Request bounds. **Brief 43.**
