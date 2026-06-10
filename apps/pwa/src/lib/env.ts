/**
 * Reveal-gesture hold duration.
 *
 * Production requires a deliberate 5-second press on the meditation circle to
 * reveal the dashboard (inspection only — never an activation trigger). During
 * development the hold is shortened to 1.5s for easier testing. An explicit
 * `VITE_REVEAL_HOLD_MS` env value overrides either default.
 */
const PROD_REVEAL_HOLD_MS = 5000;
const DEV_REVEAL_HOLD_MS = 1500;

function resolveRevealHoldMs(): number {
  const override = import.meta.env.VITE_REVEAL_HOLD_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return import.meta.env.DEV ? DEV_REVEAL_HOLD_MS : PROD_REVEAL_HOLD_MS;
}

export const REVEAL_HOLD_MS = resolveRevealHoldMs();

/** Auto-return to the meditation facade after this much dashboard inactivity. */
export const DASHBOARD_INACTIVITY_MS = 60_000;
