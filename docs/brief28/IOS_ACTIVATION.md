# BLACK BOX — iOS Activation Spec & App Review Notes (Brief 28 §5)

**Status: SPEC ONLY. No native code this build.** The iOS app is gated on an unresolved
Apple Developer account ($99/yr) and there is no StoreKit environment to build or test
against. This document is the contract the native app implements when that account
exists; the PWA + server core (Brief 28 §1–§4) is already built cross-platform-ready so
the iOS work is purely the StoreKit + first-run layer on top of the same entitlement.

The governing rule (§0) is unchanged and paramount on every platform:

> **The paywall gates ACTIVATION (arming). It NEVER gates the trigger.** An activated
> device always fires, unconditionally, forever, fully offline. Entitlement never
> expires, never re-checks, never re-locks. iOS is no exception — StoreKit gates the
> *arm affordance*, never the alarm.

---

## 1. The IAP product

| Item | Value |
|---|---|
| Product type | **Non-consumable** (one-time, permanent, restorable) |
| Product id | `com.blackbox.activation` (reserve at creation; final id TBD) |
| Price | **$34.99, one-time** — no subscription, no renewals |
| Restore Purchases | **Required by Apple** — implemented and reachable from first run + settings |
| Program | Enroll in the **Small Business Program** → 15% commission (under $1M/yr), net ≈ $29.74 |

Non-consumable is the correct type precisely because entitlement is permanent (§0). A
subscription type would contradict the "one payment, yours forever" promise and re-check
on renewal — which §0 forbids.

## 2. Cross-platform entitlement (one account, one entitlement)

Entitlement lives on the **account**, not the device or platform (§1). The native app
authenticates the same account as the PWA and reads/writes the same entitlement:

- **Buy on web → sign in on iOS →** already activated (no second purchase; the account is
  entitled). Show "Already activated" and Restore, never a price.
- **Buy via iOS IAP →** the app calls the server to record the purchase; the server
  grants entitlement with **source `purchase_ios`**, and every other surface (PWA on
  desktop, another device) sees `activated`.

Server seam (already built, iOS reuses it): entitlement is granted through the single
`grantEntitlement(env, userId, source)` path. iOS adds one server endpoint that verifies
the **App Store server notification / receipt** (server-side, never a client claim — the
web webhook in §3 is the exact same principle) and calls `grantEntitlement(userId,
'purchase_ios')`. No client-granted entitlement, ever, on any platform.

> Until the native endpoint exists, `purchase_ios` is a reserved, unused enum value in
> the schema (migration 0038) — dormant, like every other forward hook in this codebase.

## 3. First-run flow (the "inviting" part)

```
1. Open → one screen: what BLACK BOX is, in plain language. No jargon.
2. "Do you have a code from your organization?"
      YES → enter code → activated, $0, NO paywall ever shown
      NO  → "One payment. Yours forever. $34.99 — no subscription."
3. Setup → contacts → armed.
```

- **The code path is offered FIRST**, so an org-referred survivor never sees a price.
  (This mirrors the PWA: an org-sourced account renders no price anywhere.)
- Lead with **"one payment, no subscription"** — the differentiator against $8–25/month
  competitors. State it plainly on the paywall screen.
- **[A] No fear-based urgency, no countdown, no scarcity, no manipulative copy.** The
  product principle holds: fear is never a sales channel. This is a safety tool for people
  in crisis — the purchase screen is calm, honest, and skippable-with-a-code.
- **[A] The trigger works before activation** exactly as on the PWA: setup being
  incomplete is what stops an *unactivated* device being armed — but if a user fires, the
  alert still sends and records. Safety is never blocked by payment state.

## 4. App Review notes (submit these — do not skip)

These paragraphs go in **App Review notes** and the relevant parts in the **public
listing**. Concealing covert mode from Apple is what gets a disguise-mode app rejected or
pulled after launch; disclosed, it is approvable.

> **Covert / disguise mode — explicit disclosure (Guideline 2.3.1).** BLACK BOX is a
> domestic-violence safety tool. It includes an optional **disguised interface** (a
> breathing / meditation facade) so that a person living with an abuser who inspects their
> phone does not see an alarm app. This is a deliberate, user-controlled safety feature,
> not hidden or undocumented functionality: it is described in the listing, toggled by the
> user in settings, and does nothing covertly to the device or other apps. The facade
> changes only what THIS app displays. We disclose it here in full so review can account
> for it.
>
> **What the app does.** One-time purchase (non-consumable IAP) or an organization-issued
> code activates the device. Once activated, a trigger gesture sends an alert with
> location to the user's chosen contacts and records audio/video as evidence. There is no
> account-to-account visibility, no tracking of other people, and no background collection
> — capture happens only during a user-initiated alert.
>
> **Restore Purchases** is implemented and reachable from the first-run screen and from
> settings.
>
> **Test credentials / walkthrough:** [provide a sandbox account + an org code so review
> can reach the activated state without a real purchase, and a note on how to trigger and
> immediately close a test alert].

## 5. Hard constraints (the [A] non-negotiables for iOS)

- **[A] No "buy on our website" link or call-to-action inside the iOS app** outside the US
  storefront. Consumer purchase happens through IAP. **Org code entry is fine everywhere**
  — that is B2B provisioning, not a consumer purchase, and shows no price.
- **[A] Price, paywall, and purchase UI never render in the Hidden facade.** Same rule as
  the PWA §0a. The facade is byte-for-byte a meditation app; a price there is a tell.
- **[A] No entitlement/StoreKit check anywhere in the trigger, capture, or dispatch
  path.** The alarm never awaits a receipt, a network call, or a `canMakePayments`. Grep
  must prove it on the native side exactly as it is proven on the PWA (§6 guards).
- **[A] Entitlement cached locally, works fully offline.** After first activation the app
  arms and fires with no signal. A StoreKit refresh may run opportunistically to reconcile
  but must never be on the arm/fire path.
- **[A] An org license lapsing never deactivates an already-activated survivor** (§0). iOS
  reads the same account entitlement, so this holds for free.

## 6. What to build when the Apple account exists (checklist)

1. Reserve the non-consumable product id; enroll in the Small Business Program.
2. StoreKit 2 purchase + **Restore Purchases** (required).
3. Server endpoint: verify the App Store server notification/receipt **server-side** →
   `grantEntitlement(userId, 'purchase_ios')`. No client-granted path.
4. First-run flow above (code-first, then the calm one-payment paywall).
5. Reuse the PWA's entitlement cache semantics (offline-durable, never re-locking).
6. App Review notes (§4) + listing disclosure of covert mode.
7. Run the §6 trigger-path grep guard on the native source before submission.
