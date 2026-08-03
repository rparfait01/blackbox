# BRIEF 33 FIX B — THE COORDINATOR LINK IS IN THE URL

**Type:** FIX B on Brief 33 (three-role dashboard)
**Priority:** P1 — exposure on a possibly shared device
**REQUIRES:** Brief 42 green (its `Referrer-Policy: no-referrer` closes the outward leak; this
brief closes the local one). Brief 43 green.
**Ship order:** after Brief 23 Fix A, before Brief 50.
**Floor:** all shipped work. **Zero regression to a coordinator responding to a live alert.**
**Mode:** server-side plus dashboard.

---

> **THE FINDING — surfaced during Brief 42 §B.**
>
> The coordinator dashboard is reached at `/v1/c/:id/...` carrying an event-bound magic token **in
> the URL**. Brief 42 chose `Referrer-Policy: no-referrer` precisely because any policy that emits
> a `Referer` at all would leak that page to whatever the recipient clicks next.
>
> That closes the outward leak. It does nothing about the URL itself, which lands in:
>
> - the coordinator's browser history
> - address-bar autocomplete, where it surfaces on partial typing
> - cross-device browser sync
> - any screenshot, screen share, or shoulder-glance
> - the notification itself, sitting in an SMS thread or inbox indefinitely
>
> **The coordinator is typically the survivor's closest contact.** Plausibly on a shared device.
> Plausibly in the same household as the person the alert is about. A link reading
> `blackbox…/c/<event>` in a history list is a disclosure that an alert happened, to whoever
> opens that browser next.
>
> This is the same exposure class as routing survivor-facing access through marketing pages, which
> is already a locked constraint. It was applied to the survivor's device and never to the
> coordinator's.

---

## CORRECTIONS

**BRIEF 033 §DASHBOARD — corrected to read:**
"A coordinator's authority is held in a credential the browser stores, not in the address bar. A
capability token appears in a URL at most once, is redeemed on first use, and never persists in
browser history, autocomplete, or sync."
Path: `workers/api/src/dashboard/page.ts`, `workers/api/src/routes/coordinator.ts`

**BRIEF 033 FIX B §D — corrected to read:**
"The notification body states plainly what is happening: who activated, what is capturing, and
where to look. The recipient is a VETTED SUPPORT CONTACT the survivor chose, not an incidental
party, and disclosure to them is deliberate and correct. The constraint on this message is not
discretion — it is TRUTH: it names a capture only when that capture is actually running."

Final body, all channels:

```
🚨 EMERGENCY — {name} activated SENTINEL ALERT.
Live video + audio + location active.
Live dashboard: {url}
```

*(§D's original shared-device framing is STRUCK. It treated the contact as someone who might read
the thread by accident; they are the person the alert exists to reach. The exposure this brief
closes is the URL in a browser's history, which is a different thing from the message the
survivor's chosen contact is meant to read.)*

*(The video clause is CONDITIONAL and derived from evidence — `hasVideo` is true only when a
chunk with a video mimeType has actually reached the server. Absent that, the line reads "Live
audio + location active." If Brief 50 finds video unavailable on a platform, nothing here needs
changing: no video chunks arrive, so no video is claimed. A responder who reads "live video" and
opens a dashboard with no picture does not conclude the camera failed — they conclude the system
lies, at the moment they most need to trust it.)*

**BRIEF W8A (email builders; no brief document in the corpus, set in commit bfd3121) — corrected
to read:**
"The email SUBJECT renders before the body on a lock screen or a watch, so the subject IS the
alert: loud, and leading with the name. It must also name the SAME PRODUCT the body names."
Path: `workers/api/src/channels/email-messages.ts`

*(W8A marked the subject format non-negotiable and the reasoning behind that — subject-before-body
on a locked screen — is sound and preserved. What it could not anticipate is the body naming a
different product. A subject reading BLACK BOX above a body reading SENTINEL ALERT makes a
contact ask which system is contacting them, at the one moment they must not hesitate. Activation
subject is now `🚨 EMERGENCY — {name} activated SENTINEL ALERT`.)*

*(RESOLVED 2026-08-04, Royce: **BLACKBOX: SENTINEL is the product; SENTINEL is the alert.** The
escalation subject, device-dark subject and email footer are corrected accordingly.*

*Applied wider than the three enumerated, and reported rather than done quietly: four further
subjects carried the product name — closure-requested, duress, session-closed and alert-ended —
plus one SMS line. Leaving those reading "BLACK BOX" would have reproduced the exact split being
fixed, so all emitted copy now reads BLACKBOX: SENTINEL. Only the product NAME changed; no
message semantics were touched, including the duress subject's "DO NOT APPROVE". Code comments
still say BLACK BOX where they describe the history of a change.)*

**BRIEF 043 §A — corrected to read:**
"Every Hono route reading a request body does so through the bounded reader. The sweep is
verified by enumeration against the router, not by inspection — a route that was not thought of
is not covered by a rule that was applied by hand."
Path: `workers/api/src/routes/org-register.ts`

*(Origin: Brief 43 §A converted 29 body reads and MISSED `POST /v1/org-register/complete`. The
route was found by an unrelated read-only audit of Brief 24, not by the brief that claimed to have
swept it. It matters more than most: the surface is public up to its session check and it is the
front door an organization walks through, so an unbounded body on it is reachable by anyone
holding a registration link. It also took `licenseVersion` and `acceptancePath` as whatever
arrived and coerced them — a 4 KB string was accepted and RECORDED AS THE LICENCE THE ORG
ACCEPTED, which is the artifact a contract dispute turns on. Both now bounded and validated
against a closed vocabulary.)*

---

## §0 — THE CONSTRAINT THAT OUTRANKS THIS BRIEF

**A coordinator responding to a live alert must not encounter one additional step, prompt, or
decision.** Not a login, not a confirmation, not an "are you sure." They tap the link and they are
looking at the event.

Any design that adds friction to that moment is rejected regardless of what it fixes. The person
on the other end is being asked to help someone in danger, possibly at 3am, possibly on a phone
they barely use.

If the exposure cannot be closed without adding a step, **say so and close nothing** — bring the
finding back rather than shipping friction onto the alert path.

---

## §A — REDEEM ON FIRST USE

- The token in the link is single-use. First request exchanges it for the existing `bbcoord`
  cookie session and **redirects to a bare URL carrying no token**.
- The redirect replaces the history entry rather than adding one where the platform allows it, so
  the tokened URL does not survive in the back stack.
- Every subsequent request is cookie-borne. The address bar shows nothing sensitive.
- **The redirect is automatic and invisible.** No interstitial, no button, no "continue" — §0.

## §B — REDEMPTION MUST NOT LOCK ANYONE OUT

Single-use is the correct design and it is also the way to break a live response. Every one of
these is a coordinator who cannot help:

- The link is prefetched by an SMS client, mail scanner, or link-preview bot, consuming the token
  before a human taps it.
- The coordinator taps twice, or the page reloads mid-navigation.
- The coordinator opens it on their phone, then wants it on a laptop.
- The cookie is blocked, cleared, or the browser is in a mode that discards it.

Required behaviour:

- **Redemption binds to the redeeming browser, and re-presenting the same token from that same
  browser succeeds** rather than failing as replay. Only a different browser presenting a spent
  token is refused.
- A refused-as-spent token returns a plain, honest page with a **self-service** path — request a
  fresh link, delivered through the same cascade channel. Never a dead end, never a support
  request.
- **A link-scanner prefetch must not spend the token.** Redeem on a request that a human
  demonstrably made — a POST-and-redirect, or a redemption that requires a signal a prefetch does
  not produce. State the mechanism chosen and its failure mode.
- Per the standing rule, this comparison sits on the alert path: it **fails open** and is proven
  both ways before ship. A coordinator wrongly refused is worse than a token wrongly honoured.

## §C — LINKS ALREADY IN THE WILD

- Existing tokened links keep working. Nobody holding a notification from a past event finds it
  dead.
- Old-format links redeem into the new flow on next use — the same additive migration pattern as
  Brief 42 §C's two token formats.
- Report how many live events carry outstanding old-format links.

## §D — THE NOTIFICATION ITSELF

The link sits in an SMS thread or inbox permanently, and this brief cannot delete it.

- What the message *says* is in scope. Confirm the notification body does not itself disclose more
  than necessary to whoever reads that thread later, and state what it currently says.
- If the message text is more disclosing than the URL, say so — the fix would be worth more than
  this brief.
- Do not change dispatch content without surfacing the change; the wording is a safety decision,
  not a copy decision.

## §E — ANTICIPATED GAPS

1. **The dashboard polls and holds a socket.** Brief 33 Fix A bounded both. Confirm cookie-borne
   auth carries through the poll, the socket, and the SSE streams — a socket that still expects
   the token in a query string reintroduces the exposure on the wire.
2. **`bbcoord` attributes.** Brief 42 §D verified `HttpOnly`, `Secure`, `SameSite`. Redemption must
   not weaken any of them to make the redirect work.
3. **Coordinator claim is a POST.** Brief 7 locked claim to explicit interaction, never a passive
   GET. A redemption that performs a claim as a side effect of loading a page breaks that. **Keep
   redemption and claim separate.**
4. **Two coordinators, one event.** Both may hold the same link. Redemption per-browser must not
   let the first redeemer lock out the second — the cascade sends to several contacts by design.
5. **Do not solve this by shortening the token's life.** A coordinator may see the notification an
   hour late. Expiry is not the fix; the fix is that the token stops living in the address bar.

---

## ACCEPTANCE

1. Tap a fresh link → dashboard loads with **no token in the address bar**, no interstitial, no
   extra tap. Screenshot the URL.
2. Browser history after the visit contains no tokened URL. Screenshot.
3. Reload the redeemed page → still works, still cookie-borne.
4. Re-present the same token from the **same** browser → succeeds.
5. Present a spent token from a **different** browser → refused with a self-service path to a
   fresh link, and the fresh link works.
6. Simulate a link-scanner prefetch → token **not** spent; the human tap afterwards still works.
   Name the mechanism that achieves this.
7. Two coordinators, same event, both links → both reach the dashboard.
8. Old-format link from before this brief → still works, redeems into the new flow. Count of
   outstanding old-format links reported.
9. Poll, socket, and SSE all authenticate cookie-borne. **No token appears in any query string on
   the wire.** Show the requests.
10. Cookie blocked or cleared → honest failure with a self-service path, never a blank page.
11. Coordinator claim still requires explicit interaction; redemption does not claim.
12. §D: current notification body reported verbatim, with an assessment of what it discloses.
13. Full end-to-end: real trigger, cascade, coordinator taps, takes coordination, sees the event.
    **Timed** — report the delay from tap to dashboard, before and after. Any increase is a
    finding.
14. Full acceptance suite, 90/90.

---

## CARRIES FORWARD (open, owned by)

- **Brief 50** — capture integrity and live relay. Next after this.
- **Brief 51** — device session and arming. Royce's phone, in parallel.
- Brief 24 org registration. Brief 26 ZK custody. Brief 0B closure scales. Double-tap gesture
  items.
