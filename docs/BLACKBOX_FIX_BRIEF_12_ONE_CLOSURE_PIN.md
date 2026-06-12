# BLACK BOX — Brief 12: One Closure Pin (Settings alignment)

Closes a gap inside the Phase D closure flow: Settings still edits the legacy 4-digit / server
pin, not the new 3-digit on-device closure pin — so changing the pin in Settings does not change
what closure uses. Do this BEFORE Phase C. The closure flow cannot be validly tested until it is
fixed. Device-verify on a clean build.

## One pin, one source of truth
- The 3-digit on-device closure pin is the ONLY pin. Settings sets and changes exactly that pin.
- Both evaluations key off it:
  - SAT = entered pin equals the registered closure pin.
  - DURESS = entered pin equals the registered closure pin with only the LAST digit altered.
  - The registered closure pin is therefore the baseline for BOTH. If Settings edits a different
    pin, duress compares against the wrong baseline and the last-digit-altered signal misfires.
    This is the load-bearing reason to align it — not cosmetics.
- Drop the now-defunct "backup code" control.
- Retire the legacy 4-digit / server pin from the closure path entirely. Closure references the
  same pin Settings sets, and nowhere else.

## Acceptance criteria (device-verified, clean relaunch)
1. Changing the closure pin in Settings changes what closure actually evaluates.
2. At closure, the Settings-set pin reads SAT; that same pin with the last digit altered reads
   DURESS / UNSAT.
3. No "backup code" control remains, and no legacy pin path governs closure.
