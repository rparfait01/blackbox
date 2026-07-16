# BLACK BOX — FIX BRIEF 19 — Selectable check-in recipient (retire guardian-hardcode)

**Floor:** current known-good. Do not regress trigger (either mode) or closure.
**Mode:** deployed production. Proof is the designated person actually RECEIVING a check-in.
**Supersedes:** Brief 17 §1's "check-in recipient = guardian" default. Check-in no longer hardcodes to guardian.

---

## DIAGNOSIS ON RECORD (settled — do not re-diagnose)

Check-in reaches the server (200) and works mechanically. It returns `recipients: 0` because it defaults to
the **guardian slot**, and the live account (`0e549c5b`, royce.ikumi.parfait@gmail.com) has a deliverable
LINE contact but **no guardian**. Zero recipients = correct behavior for a guardian-hardcoded route against an
account with no guardian. The fix is to route check-in to a **user-designated contact**, not the guardian.

---

## THE CHANGE — one designated check-in person, selectable, changeable on the fly

Check-in is a **single-recipient heartbeat**, never a cascade (unchanged). What changes is WHICH single person:
the user picks a contact to be their check-in partner, and can change it anytime.

### Data model
- Account-level field: `checkinContactId` → references one row in `contacts`.
- **Default when unset:** the **primary contact** (lowest priority number / priority 1). Never guardian.
- On the fly: writing a new `checkinContactId` takes effect immediately; no re-onboard, no session.

### UI — under the contacts list (both Present modes)
- A selectable designation on the contacts screen: each contact shows a "Check in with" selector
  (radio / single-select — exactly one contact can hold it at a time).
- Selecting a different contact reassigns instantly and persists. The currently-designated contact is clearly
  marked. This is the "selectable block/annotation under contacts" — identification + routing in one control.
- If exactly one contact exists, it is the check-in recipient by default (still shown as designated).

### Server — `sendCheckin`
- Resolve recipient in this order: `checkinContactId` if set and deliverable → else primary contact if
  deliverable → else **honest failure**.
- **Kill the silent success:** NEVER return `ok: true` with `recipients: 0`. If no deliverable recipient
  resolves, return a surfaced failure the client shows: "No check-in recipient set." `ok: true` only after the
  dispatch to the designated contact actually succeeds on its channel.
- Deliver status + timestamp + location (payload already carries them) to the designated contact's endpoint.
- **Dormant-only, unchanged:** no event, no capture, no coordinator, no cascade. Never promotes to an alert.

### Also clean (same pass)
- Payload still carries a vestigial `includeLocation: true`. Brief 17 §1 made check-in a single button with
  location always captured. Remove the flag; location is unconditional. Client and contract match.

---

## ACCEPTANCE
- `[A]` `checkinContactId` field exists; unset defaults to primary; server resolves designated → primary →
  honest-fail in that order; no path returns `ok: true` with `recipients: 0`.
- `[L]` on deployed app: designate contact 1 → tap check-in → **contact 1 actually receives status + time +
  location** (confirm on the receiving device) → user sees real delivered confirmation.
- `[L]` change designation to a different contact on the fly → next tap delivers to the new person.
- `[L]` account with zero deliverable contacts → user sees "no recipient set," NOT a fake success.
- No regression: trigger (both modes) and closure unchanged; check-in stays dormant-only.

---

## NOTE FOR ROYCE
Default-to-primary is chosen so an unset field never silently sends to nobody. If you want check-in to require
an explicit pick with NO fallback, that's one line — say so and the resolve order drops the primary fallback.
