/**
 * Activation-hold duration — how long the user must press the breathing circle
 * for the covert activation trigger to fire.
 *
 * Production requires a deliberate 5-second press. During development the hold
 * is shortened to 1.5s for easier testing. An explicit `VITE_REVEAL_HOLD_MS`
 * env value overrides either default. (The env var keeps its original name for
 * config compatibility, though the gesture now triggers activation rather than
 * revealing anything.)
 */
const PROD_HOLD_MS = 5000;
const DEV_HOLD_MS = 1500;

function resolveHoldMs(): number {
  const override = import.meta.env.VITE_REVEAL_HOLD_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return import.meta.env.DEV ? DEV_HOLD_MS : PROD_HOLD_MS;
}

export const ACTIVATION_HOLD_MS = resolveHoldMs();
