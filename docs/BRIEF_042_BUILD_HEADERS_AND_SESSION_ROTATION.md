# BRIEF 42 — SECURITY HEADERS AND SESSION ROTATION

> **CARRIED IN FROM BRIEF 41 — do these as part of this brief.**
>
> **1. Finish Brief 41 acceptance 2, 3, 6, 7. Do them first; they are cheap and they are the
> guarantees Brief 41 exists for.**
>
> - **Acceptance 3 — prove it live on STAGING, not production.** Lift the staging exemption for
>   one non-reserved identifier, drain the unauthenticated outbound cap, then fire a real
>   trigger and confirm the cascade delivers in full from the reserved allocation. Staging is
>   severed to `blackbox-test` / `blackbox-media-test` / `blackbox-vault-test`, so no real
>   recipient is touched and no production quota is spent. Restore the exemption afterward and
>   confirm it is restored. **Do not run this on production.**
>   Rationale: every property this project has proven by construction has failed on its first
>   live run — the capability key rotation, `expectedPublicKey`, `PURGED_BY_CONSENT`. The
>   reserved allocation is the last guarantee still resting on construction, and it is the one
>   that decides whether a survivor's cascade survives an attack.
> - **Acceptance 2 — measure the timing distribution.** Identical response bodies are not
>   sufficient; report the distribution for existent vs non-existent identifiers.
> - **Acceptance 6 — exercise the limiter store failure live on staging.** It must fail open and
>   alert. A limiter that fails closed takes down login for everyone.
> - **Acceptance 7 — confirm the sustained-limiting alert actually reaches an operator**, not
>   just that it fires. That is a targeted attack on one survivor; a signal nobody receives is
>   not a signal.
>
> **2. Ratified, add to `STANDING_CONSTRAINTS.md` verbatim:**
> "Safety-critical exemption is an allow-list, never a deny-list. A path is unlimited,
> unthrottled, or ungated because it was never added — not because someone remembered to exempt
> it. A deny-list silently captures every route added after it was written, and that failure is
> invisible until the day it matters."
> *(Origin: Brief 41 `LIMITED` / `ruleFor()` returning null for anything absent.)*
>
> "A measurement must measure the thing the limit acts on. A per-path total says nothing about a
> per-identifier bucket, and reporting one as the other condemns a correct control or exonerates
> a broken one."
> *(Origin: Brief 41 §F reporting 149 signups against a burst of 12 — 149 distinct identifiers,
> one attempt each.)*
>
> **3. Ratified without change:** the §F exemption completion (canary by server-derived identity,
> D1 read only when a request is about to be rejected, so §E4 holds); the corrected §F cost
> report; burst-then-decay with no lockout state.
>
> **4. Do not arm anything.** Brief 36 item 12 and Brief 2 Fix A §E3 both wait on Royce's device
> session.
>
> **5. Still open, not this brief:** Brief 2 Fix A acceptance 2, 7, 8, 11 (device session);
> `CF_ANALYTICS_TOKEN` unset so headroom reads `NOT MEASURED`; `master` 157 commits behind HEAD.

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

**Two token formats now exist.** Brief 2 Fix A replaced `<userId>.<issuedAt>.<hmac>` with
`bbxs1.<AES-GCM(...)>.<hmac>`, and legacy tokens verify indefinitely because sessions never
expire and signing out every live user is itself a safety failure. Rotation must therefore:

- Accept either format as the **input** to a rotation.
- Always emit `bbxs1.` as the **output**. Rotation is the migration path — a privilege
  transition is the natural moment to upgrade the format without an expiry event.
- Invalidate the presented token regardless of which format it was.
- Never require a legacy holder to re-authenticate. A survivor signed out by a housekeeping
  change is a survivor who cannot trigger until she remembers a credential.
- Report legacy-format share on the readiness panel, so the eventual retirement of the old
  format is a decision made with data rather than a guess.

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
5. **Rotation touches the path the trigger authenticates on.** A rotation bug that invalidates a
   valid session is a survivor who cannot trigger. Per the standing rule, any new comparison on
   the trigger, capture, cascade, or closure path fails open by default and is proven both ways
   before ship.
6. **`extractable: false` device keys are bound to the origin, not the session.** Confirm
   rotation does not orphan a provisioned device credential — the credential outlives the
   session by design.

---

## ACCEPTANCE

1. Brief 41 acceptance 2, 3, 6, 7 complete, per the carried-in block above. **Report acceptance 3
   as a live staging run with the exemption lifted and restored.**
2. Headers present on every served route. Show the response.
3. Report-only pass over both Present modes with real use → zero violations before enforcing.
4. Enforced CSP: **facade renders byte-identically in Hidden.** Diff, both modes screenshotted.
5. Service worker registers under enforcement; offline capture works.
6. Trigger, capture, closure, cascade, coordinator dashboard all function under enforcement.
7. Session rotates at each named transition; old identifier rejected.
8. **Legacy-format token presented at a rotation → accepted, upgraded to `bbxs1.`, old token
   invalidated, holder never signed out.** Prove with a real legacy token.
9. **Rotate mid-alert → event stays live, cascade continues.** Screenshot.
10. Rotation does not orphan a provisioned device credential.
11. Readiness panel reports legacy-format share.
12. Coordinator cookie attributes verified; no token in referrer.
13. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- Request bounds. **Brief 43.**
