# BRIEF 2 FIX A — scope additions (recorded 2026-08-02)

Added by Royce during Brief 30 Fix A. Subject of Brief 2 Fix A: **identifiers doing an
authority's job.** These belong here rather than in a new brief.

## Addition 1 — the session token must not publish the account identifier

`mintSession` produces `<userId>.<issuedAt>.<hmac>`. The account identifier is the literal first
component, in plaintext, of every session token the product has ever issued.

That was survivable only while a `userId` granted nothing. It did not: until Brief 30 Fix A
(`19c577b`) a bare `userId` finalized any account into a full session, flipped a covert user to
direct, and re-minted their recovery codes. So every session token that was ever logged,
screenshotted, shoulder-surfed or pasted into a support thread also carried a permanent,
non-expiring takeover key.

Brief 30 Fix A closed the takeover. It did **not** close the disclosure: the identifier is still
published by the token format, and any future route that trusts a `userId` inherits the same
exposure.

**Requirement:** the session token format must not publish the account identifier. Opaque
(random, looked up server-side) or derived (so the identifier cannot be read back out).

**Constraint carried from `no-unintentional-signout`:** sessions never expire and no error path
may end one. A format change must therefore be additive — old tokens keep working until they are
replaced, or every signed-in user is signed out, which is itself a safety failure.

## Addition 2 — sweep every route accepting a user id from a body or query

**Sweep performed 2026-08-02 against `19c577b`. Three sites, none with the signup defect.**

| Route | Reads | Independent credential | Verdict |
|---|---|---|---|
| `POST /v1/admin/entitlement/grant` | `body.userId` \| `body.email` | `app.use('/v1/admin/*')` → Bearer `ADMIN_TOKEN` | target only |
| `POST /v1/admin/entitlement/revoke` | `body.userId` \| `body.email` | same | target only |
| `POST /v1/console/maintenance/delete-account` | `body.userId` \| `body.email` | `requireLevel('operator')` | target only |

The distinction is the whole point: in all three the identifier says **who to act on** while a
separate credential says **who is acting**. The signup defect was the identifier doing both jobs
at once.

Also swept, and clean:

- **Event path.** `hmacAuth` takes `eventId` from the path but authenticates with the per-event
  `hmacSecret` over `METHOD\npath\ntimestamp\nsha256(body)`, with a 5-minute freshness window
  (`maxSkewMs = 300_000`). Identifier names the target, secret proves authority. Replay is bounded.
- **No `:userId` path-parameter routes exist.**

## Open finding, out of scope for Brief 30 Fix A

`GET /v1/admin/events/<any-nonexistent-id>/chain` returns `VERIFIED — no records to verify`. An
unknown event id must not read VERIFIED; the verdict cannot currently distinguish "nothing
happened" from "no such event". Brief 37 §E territory.
