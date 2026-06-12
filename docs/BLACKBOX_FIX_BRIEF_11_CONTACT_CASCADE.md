# BLACK BOX — Brief 11: Sequential Contact Cascade (Phase C, corrected)

Corrects the dispatch model. Brief 10 deployed immediate fan-out to all contacts at once; that
overrode the established sequential order. Replace it with a sequential, cascading dispatch. Build
this when you reach Phase C (order remains D → E → C). Device-verify on a clean build.

## Cascade model
- On activation, notify contacts in PRIORITY ORDER, one at a time, 15 seconds apart:
  - T+0s: primary contact
  - T+15s: secondary contact
  - T+30s: tertiary contact
  - T+45s: guardian (if enabled)
  - [CONFIRM: guardian fires last in the cascade. If you want the failsafe pinged immediately in
    parallel instead, say so.]
- The first contact is the preferred coordinator; the 15s head-start gives them first claim.
- First to claim coordinator owns the role (full access via the existing cookie/interaction
  claim); anyone notified after that gets the location-only / informed view.
- [CONFIRM: once a coordinator is claimed, the cascade STOPS firing further notifications (the
  responsibility is owned; the rest aren't alarmed). If no one claims, the cascade runs to the end
  of the chain, then escalates to the emergency-services fallback. If you'd rather everyone be
  notified regardless of claim, say so.]

## Keep from Brief 10 (do NOT regress)
- Recipients are resolved FRESH each dispatch — a newly added contact is always included. The
  earlier bug (a second contact receiving nothing) must not return. The cascade staggers WHEN each
  recipient fires, never WHETHER they are included.
- Per-channel delivery_records logging and the single whole-cascade retry remain.

## Emergency-services fallback
- If the full cascade completes with no coordinator claimed, escalate to emergency services via
  SMS / LINE after the configured window. Windows configurable per account.

## Acceptance criteria (device-verified, clean relaunch)
1. On activation, contacts are notified in priority order at ~15s intervals, not all at once.
2. Every configured contact (including a newly added one) is reached by the cascade; none dropped.
3. The first to claim becomes the sole coordinator; later recipients get the location-only view.
4. Per the confirms above: the cascade halts on claim, and completes to the emergency-services
   fallback if no one claims.
