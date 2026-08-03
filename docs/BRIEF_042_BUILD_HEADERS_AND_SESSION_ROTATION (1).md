# BRIEF 42 — SECURITY HEADERS AND SESSION ROTATION

> **FINISH BRIEF 35 FIX B AND BRIEF 41 FIRST — then build this brief.**
>
> **1. Brief 35 Fix B §D — the retrofit, which is the bulk of §D and is outstanding.**
> The channel is built; the call sites still `console.log`. Convert every error-level alert to
> the channel and report the list: `canary_flag_on_non_canary_account`,
> `routable_contact_on_canary_account`, seal-pending threshold, vault backlog, sustained
> limiting, `UNAVAILABLE` / `QUOTA_EXCEEDED` gate outcomes, storage degradation, headroom 80%,
> environment-indeterminate dispatch. **An alert not on the reported list is an alert that still
> goes nowhere.**
>
> **2. Acceptance 8 and 9 — authorized. Fire them.** Roughly twelve emails to the inbox is the
> correct price for proving alerts arrive. Then prove storm collapse: count plus first and last,
> none dropped.
>
> **3. Brief 35 Fix B acceptance 11 and 12** — limiter store unavailable fails open and alerts;
> sustained limiting on one identifier alerts and **arrives**. 12 depends on the retrofit.
>
> **4. Re-run the invalidated results.** The harness POSTed contacts to `/v1/me/contacts/1` when
> slots are named, so every call returned 400 unchecked and the address book was empty. Dispatch
> results are void for **Brief 2 Fix A acceptance 9** and the **first Brief 41 acceptance 3
> attempt**. Their trigger and capture results stand. Re-run both dispatch proofs with a real
> named-slot contact.
>
> **5. Staging credential panel — report a third state, not an amber light.**
> `absent`, `placeholder — present, non-authenticating`, and `present` are three different facts.
> The panel reports what it observes. It does not assert authenticity it cannot verify, and it
> does not collapse placeholder into absent. Per the standing rule: panel values are derived from
> what the system observes.
>
> **6. Ratified, add to `STANDING_CONSTRAINTS.md` verbatim:**
> "A test harness asserts its own setup succeeded. An unchecked non-2xx during setup makes every
> downstream reading meaningless — an empty address book reads as a failed cascade, and a test
> that can never pass is the mirror of a test that cannot fail."
> *(Origin: `/v1/me/contacts/1` against named slots; `@nonexistent.invalid` suppressed as a
> reserved TLD before reaching the cap.)*
>
> "A reserved or sentinel value is inert by design. A test that drives a control with one proves
> the control was never reached."
>
> **7. Ratified without change:** §A's environment stamp living inside the database the binding
> points at — a Worker wired to `blackbox-test` reads staging regardless of vars, hostname, or
> deploy command, and making staging dispatch requires pointing it at the production database, at
> which point it is production. The outbound-fetch enumerating guard. §B's inversion, proven live
> when production ran `INDETERMINATE` between deploy and stamp and correctly dispatched
> throughout. §C placeholders over deletion — deliverability is a presence check.
>
> **8. Acceptance 10 stands as the strongest proof in the set:** the emergency contact was the
> same address whose non-alert cap was drained, 10 sends against a cap of 5, then a real trigger
> delivered with zero rows blocked. Abuse against an identifier cannot starve that identifier's
> own alert.
>
> **9. Do not arm anything.** Brief 36 item 12 and Brief 2 Fix A §E3 wait on Royce's device
> session.
>
> **10. Still open, not this brief:** Brief 41 acceptance 2 — the timing oracle, +23ms on
> existent addresses, fix by equalising the work in Brief 41 §B, not a sleep and not a random
> delay. Brief 2 Fix A acceptance 2, 7, 8, 11 — device session. `CF_ANALYTICS_TOKEN` unset;
> headroom reads `NOT MEASURED`. `master` 157 commits behind HEAD.
>
> **11. Queue after this brief:** Brief 43 (bounds — closes the audit set), Brief 23 Fix A
> (tenancy), then **Brief 50** (capture integrity and live relay — written from a live two-mode
> test where video was absent in both modes and the summarizer failed in Visible while working
> in Hidden).

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
