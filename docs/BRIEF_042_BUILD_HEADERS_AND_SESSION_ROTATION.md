# BRIEF 42 — SECURITY HEADERS AND SESSION ROTATION

> **CARRIED IN — the prior block is complete. These are new.**
>
> **1. Ratified, add to `STANDING_CONSTRAINTS.md` verbatim:**
> "Any counter a security decision depends on lives in durable storage, not isolate memory.
> Isolate-local state answers a question about one isolate, which is never the question being
> asked. Second occurrence of the isolate class: the capability key rotation recomputing against
> whatever key was current, and the rate limiter counting refusals per isolate so a targeted
> attack on one survivor never crossed the alert threshold."
>
> "A guard that extracts a region of code asserts its landmarks were found. A slice whose start or
> end marker is absent silently runs to end-of-file and the guard tests nothing. Test the property,
> not the spelling."
> *(Origin: the hot-path guard bounded by a comment `code()` had already stripped — the same
> mistake made twice inside a guard written to enforce the rule against it.)*
>
> **2. Ratified without change:** the §D retrofit and its ten types; the two-way guard (a named
> error-level alert without `operatorAlert` fails, and a declared type nothing raises fails —
> which caught `integrity_do_unbound`); migration 0058 writing refusals to D1 only after the
> refusal, so §E4 holds and the cost lands on the attacker; the three-state credential panel with
> no permanent amber; acceptance 8 at 12/12 and acceptance 9 collapsing 26 to one immediate plus
> one summary with none dropped.
>
> **3. Brief 35 Fix B acceptance 11 stays open, and that is the correct call.** Forcing an
> isolate-memory failure live would require a bypass in the limiter, and a test-only hole in a
> security control is worse than an unproven acceptance row. Leave it unit-covered and recorded as
> open. Do not add the hole.
>
> **4. Status correction for the record:** Brief 42 was reported shipped. It was not — its
> carried-in block was. This brief proper has not started.
>
> **5. Build the facade-diff harness first.** §E4 requires the Hidden facade to be diffed, not
> eyeballed, and no harness exists. It is the first task of this brief, the same shape as the
> latency harness that made Brief 2 Fix A §0 checkable. **Do not begin CSP work before it exists**
> — enforcing a CSP without a way to prove the facade is byte-identical is enforcing blind.
>
> **6. Do not arm anything.** Brief 36 item 12 and Brief 2 Fix A §E3 are owned by **Brief 51**
> (VERIFY — device session and arming), which runs on Royce's phone in parallel.
>
> **7. Queue after this brief:** Brief 43 (bounds — closes the audit set, and carries the timing
> oracle, `CF_ANALYTICS_TOKEN`, and the `master` reconciliation), then Brief 23 Fix A (tenancy
> attribution — `orgId` stays nullable, no mandatory affiliation), then Brief 50 (capture
> integrity and live relay).

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
