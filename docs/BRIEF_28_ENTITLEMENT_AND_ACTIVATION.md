# BRIEF 28 — ENTITLEMENT & ACTIVATION (PWA lock · web sale · code unlock · App Store IAP)

**Gate: after Brief 23 (Tenancy) — org codes need the seat model.**
**iOS work is additionally gated on the Apple Developer account ($99/yr, unresolved).**

---

## §0 — THE SAFETY LINE (read first — this governs everything below)

**The paywall gates ACTIVATION. It NEVER gates the trigger.**

| State | Meaning | Trigger |
|---|---|---|
| **Unactivated** | Installed, not yet a safety device. No contacts, not armed. | N/A — setup incomplete |
| **Activated** | Paid, code-redeemed, or org-enrolled | **Always fires. Unconditionally. Forever.** |

- `[A]` **No entitlement check may exist anywhere in the trigger, capture, or dispatch path.** Grep must prove it.
- `[A]` **Entitlement never expires, never re-checks, never re-locks.** One-time purchase means permanent.
- `[A]` **Entitlement is cached locally and works fully offline.** A survivor with no signal must still have a
  working device. Never require a network call to arm or fire.
- `[A]` **An org license lapsing does NOT deactivate already-activated survivors.** It blocks *new* enrollments
  only. A survivor never loses protection because an organization's paperwork expired.

---

## §1 — ENTITLEMENT MODEL

On the account, not the device, not the platform.

| Field | Values |
|---|---|
| `entitlement` | `unactivated` \| `activated` |
| `entitlement_source` | `purchase_web` \| `purchase_ios` \| `org_code` \| `operator_grant` |
| `activated_at` | timestamp |

- **Org membership and entitlement are separate concerns.** An org code grants **both**. A purchase grants
  **entitlement only** (no org, no coordinator).
- `[A]` One account = one entitlement, portable across PWA and iOS. Buy on web → sign in on iOS → activated. Buy
  via iOS IAP → open the PWA on desktop → activated.

---

## §2 — PWA: HOW THE LOCK WORKS

**What's free without activation:** install, create an account, complete setup, read everything.
**What activation unlocks:** arming the device — contacts confirmed, Armed state, live trigger.

- Price is stated **before** setup begins. No surprise wall after ten minutes of work.
- `[A]` The gate sits at **arm**, not at install, not at signup.
- `[A]` Entitlement is written to the account server-side and cached client-side. **Once activated, no further
  server check is ever required to arm or fire.**
- `[A]` §0a: pricing, paywall, and purchase UI **never** render in the Hidden facade.
- `[A]` An org-enrolled survivor **never sees a paywall, a price, or a purchase prompt.** Ever.

## §3 — PWA: HOW THE SALE WORKS

```
Site checkout (Stripe / Gumroad / PayPal)
   → payment succeeds
   → account activated directly (if signed in)  OR  activation code emailed (if not)
   → sign in → armed
```

- `[A]` Payment confirmation must be **server-verified** (webhook / server-side verification). Never trust a
  client-side "payment succeeded" redirect to grant entitlement.
- `[A]` If payment succeeds but activation fails, **surface it loudly and recover** — never take money and leave
  an account unactivated silently.
- **RESOLVED — refund / chargeback: NO automatic revocation.** An operator may revoke manually for fraud, and
  every revocation is logged. Auto-killing a safety device over a payment dispute is not an acceptable risk.
---

## §4 — CODES: ISSUANCE, THROUGHPUT, ACCESS

Extends Brief 23's `enrollment_codes`. **Do not build a second code system.** One table, one redemption path.

| Property | Value |
|---|---|
| Default | **Single-use** — one code, one account |
| Multi-use | Coordinator-issued, **explicit expiry required**, bounded `max_uses` |
| Grants | Entitlement **+** org membership (org codes) · entitlement only (operator grant) |
| Expiry | **Required.** Default 7 days |
| Revocable | By issuer or org admin, any time before redemption |
| Format | 8–10 chars, unambiguous alphabet (**no 0/O, 1/I/l**) — coordinators read these aloud |
| Seat ceiling | Redemption **refused past `seats_total`**, server-side |
| Redemption attempts | **Rate-limited server-side.** Short codes must not be brute-forceable |
| Audit | Who issued · when · who redeemed · when · from where |

- `[A]` **A leaked code grants activation only — never access to any existing survivor's data.** This is the
  containment property. Test it explicitly.
- `[A]` A code cannot be redeemed twice. A consumed code returns a clear, honest message — never silent failure.

### Management views

| Who | Sees |
|---|---|
| **Coordinator** | Codes they issued: status, expiry, uses remaining, redeemed y/n |
| **Org admin** | All org codes · seats total/used/remaining · issuance audit |
| **Operator (you)** | All orgs, all codes, seat ceilings, redemption rates, manual grant + revoke (logged) |

- `[A]` Seat exhaustion must be **visible to the admin before it bites** — surface remaining seats, and warn as
  the ceiling approaches. A coordinator discovering they're out of seats while sitting with a survivor is a
  failure.

---

## §5 — APP STORE: SETUP & FIRST RUN

**Free download. IAP inside. Enroll in the Small Business Program → 15%, not 30%.**

| Item | Value |
|---|---|
| IAP product type | **Non-consumable** |
| Price | $34.99, one-time |
| Restore Purchases | **Required by Apple.** Must be implemented and reachable |
| Commission | 15% (Small Business Program, under $1M/yr) → you net ~$29.74 |

### First-run flow (the "inviting" part)

```
1. Open → what BLACK BOX is, in one screen. No jargon.
2. "Do you have a code from your organization?"
      YES → enter code → activated, $0, no paywall ever shown
      NO  → "One payment. Yours forever. $34.99 — no subscription."
3. Setup → contacts → armed.
```

- Lead with **"one payment, no subscription"** — that is the differentiator in a category of $8–25/month
  competitors. Say it plainly on the paywall screen.
- The code path is offered **first**, so an org-referred survivor never sees a price.
- `[A]` No fear-based urgency, no countdown, no scarcity. Principle rule: never use fear as a sales channel.
- `[A]` Purchase and price UI **never** appear in the Hidden facade.

### App Review (do not skip)

- `[A]` **Disclose the covert/disguise mode explicitly** in App Review notes and the listing. Guideline 2.3.1
  prohibits hidden or undocumented functionality. Disguise-mode safety apps are approvable **when disclosed** —
  concealing it from Apple is what gets an app rejected or pulled after launch.
- `[A]` **No "buy on our website" link or call-to-action inside the iOS app** outside the US storefront. Org code
  entry is fine — that is B2B provisioning, not a consumer purchase.

---

## §6 — GUARDS

- `[A]` Trigger, capture, closure, dispatch: **zero entitlement checks.** Grep-proven.
- `[A]` Entitlement works offline, permanently, after first activation.
- `[A]` Org-enrolled and shelter survivors never see price, paywall, or purchase UI.
- `[A]` §0a Hidden facade byte-identical — no pricing, no paywall, no purchase, no tell.
- `[A]` Server-verified payment only. No client-granted entitlement.

## ACCEPTANCE

- `[L]` Unactivated account: completes setup, hits the gate at **arm** — not at install or signup.
- `[L]` Web purchase → server-verified → account activated → arms successfully.
- `[L]` Org code redeemed → activated, **no paywall shown at any point**.
- `[L]` Activated account **arms and triggers with the network fully offline.**
- `[L]` Activated account still triggers after its org's license is marked lapsed.
- `[L]` Code: single-use enforced · expired refused · revoked refused · past seat ceiling refused · redemption
  rate-limited · consumed code returns an honest message.
- `[L]` A leaked code grants activation only — no access to any existing survivor's data.
- `[L]` iOS: free download · code path offered before price · IAP completes · **Restore Purchases works**.
- `[L]` Cross-platform: buy on web → activated on iOS; buy on iOS → activated in PWA.
- `[A]` No entitlement check exists in trigger/capture/dispatch. §0a Hidden byte-identical.
- `[L]` Safety floor unregressed.

## DONE
Entitlement lives on the account and is permanent, offline-durable, and portable across PWA and iOS. Activation
comes from web purchase, org code, or iOS IAP — and never gates the trigger. Codes are single-use, expiring,
revocable, seat-bounded, rate-limited, and auditable through one shared system. Committed and pushed; both deploy
halves currency-asserted; phone sign-off.

