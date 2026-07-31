# BLACK BOX — Brief 14: Unbrick the Front Door (root-cause, not symptoms)

Three reported failures — can't create an account ("could not send the verification email"),
can't log in with a known-good account, can't clear contacts — are **one root cause**: an
email-verification dependency was placed in front of the auth chain, the email send fails, so
signup and login both break, and with no valid session every authenticated call (including contact
delete) fails too.

Do not patch these one at a time. Remove the broken dependency.

---

## P0 — Remove email verification from the pilot critical path
- **Signup must never depend on an outbound email succeeding.** Create the account immediately,
  store the email as `unverified`, and return success. No email send is required to finish signup.
- **Login must not require a verified email**, and must not use a magic-link / emailed-code flow as
  the only path. Confirm there is a password (or equivalent) login that needs zero email delivery.
  A previously-good account must log in.
- Find every place auth touches email delivery (signup verify-send, login magic link/OTP, any
  "verify before X" gate) and take it out of the critical path. Verification, if kept at all,
  becomes an optional, **non-blocking** action after the account already works.
- If an email provider is wired (Resend/SendGrid/etc.) and unconfigured, that's fine — it must not
  block anything. No external service (email or SMS) belongs in the signup/login path for the pilot.

## P0 — Re-verify the three symptoms against the RUNNING app, not the compiler
The prior "fixes" reported green because they were checked with `tsc`/unit tests. Those don't prove
the deployed app works. Verify each of these by hitting the **deployed Worker** with real requests
and pasting the actual HTTP status + body as proof:
1. **Create account** — new email, returns 200 + a session/token, no email dependency.
2. **Log in** — the known-good account logs in, returns a valid session.
3. **List contacts** → **delete a contact** → **list again** — delete returns success and the
   contact is gone, with the remaining contacts reindexed contiguously (1,2,3 → no gap).

Minimal smoke script (adapt routes to the real ones in code, run against the deployed API):
```bash
API=https://blackbox-api.stillpoint-dev.workers.dev
# 1. signup
curl -i -X POST $API/v1/signup -H 'content-type: application/json' \
  -d '{"first":"Test","last":"User","nationality":"US","email":"smoke+1@example.com","password":"..."}'
# 2. login (capture the token)
curl -i -X POST $API/v1/login -H 'content-type: application/json' \
  -d '{"email":"smoke+1@example.com","password":"..."}'
# 3. contacts: list / add / delete / list  (use the token from login)
curl -i $API/v1/me/contacts -H "authorization: Bearer $TOKEN"
curl -i -X POST $API/v1/me/contacts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{...}'
curl -i -X DELETE $API/v1/me/contacts/2 -H "authorization: Bearer $TOKEN"
curl -i $API/v1/me/contacts -H "authorization: Bearer $TOKEN"
```
Each step must return success against the deployed endpoint. If contact-delete still fails, the
cause is the auth/session (no valid login) or a CORS method on the real route — not the in-memory
test. Trace it on the live request.

## P1 — Back button after "Get Started"
- Once the user taps "Get Started," every onboarding screen needs a way back. Add a back control to
  each step so a user can return without being trapped or force-reloading.

---

## Reporting rule (so this stops happening)
- An `[A]` item is "passing" only when it has been exercised against the running deployed app, with
  the real request/response shown. `tsc` + build + unit tests are necessary but **not** sufficient
  and must not be reported as a passing functional test.
- If a path can't be tested because a service isn't configured, say so explicitly — do not report it
  as passing.

## Housekeeping
- No git remote is configured, so nothing is backed up off the machine. Add one and push the branch:
  `git remote add origin <url>` → `git push -u origin fix/server-authoritative-lifecycle-and-custody`.

## Acceptance criteria (device + deployed API, clean build)
1. A new user creates an account on a phone with no email step and no email failure possible.
2. The known-good account logs in with no verification gate.
3. Contact delete succeeds on the live API and remaining contacts reindex contiguously.
4. Every onboarding screen after "Get Started" has a back control.
5. The three smoke-test results are pasted as real HTTP responses, not "tests pass."
