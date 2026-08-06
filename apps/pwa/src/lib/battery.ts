import { log } from '@/lib/log';

/**
 * BRIEF 59 — WHAT AN ACTIVE EVENT COSTS THE PHONE.
 *
 * A survivor reported 10–11% battery with an alert running and asked what an hour costs. Nothing
 * measured it, so the only honest answer was an inference from what the code keeps switched on —
 * a wake lock holding the screen, continuous H.264 encode, a GPS watch, a heartbeat, a classifier
 * tick and an animation frame. That is a defensible estimate and it is not a measurement.
 *
 * ═══ TWO READINGS, NOT A SERIES ══════════════════════════════════════════════════════════════
 *
 * One at trigger, one at close. Two numbers and the event duration give a RATE, which is the
 * entire question. A poll would put another recurring timer on the alert path, and the last week
 * of this project is a catalogue of what recurring timers cost when nobody bounds them.
 *
 * ═══ WHY THIS IS SAFE TO COLLECT ═════════════════════════════════════════════════════════════
 *
 * `navigator.getBattery()` requires no permission and shows no prompt. Only the LEVEL and the
 * charging flag are read. The `dischargingTime`/`chargingTime` estimates — the high-entropy
 * fields the fingerprinting research is actually about — are deliberately never touched, because
 * they answer no question we have.
 *
 * ═══ NULL IS THE NORMAL CASE ═════════════════════════════════════════════════════════════════
 *
 * Firefox removed the API and no iOS browser has ever implemented it, so a large share of real
 * devices will report nothing. That is why every path here returns `null` rather than a default:
 * a stored null means NOT REPORTED, and it must never be readable as 0%. A battery figure that
 * silently defaults is the same defect class as a capture claim nobody observed.
 */

export interface BatteryReading {
  /** 0–1. Never defaulted; absent readings are `null` at the call site, not 0. */
  level: number;
  charging: boolean;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

/**
 * Read the battery once. Never throws, never prompts, never blocks for long.
 *
 * Wrapped in a timeout because this runs on the ACTIVATION PATH: `getBattery()` returns a promise
 * and a platform that never settles it must not be able to delay a trigger. Nothing here is
 * allowed to stand between her and the alert.
 */
export async function readBattery(timeoutMs = 400): Promise<BatteryReading | null> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (typeof nav.getBattery !== 'function') {
      return null; // Firefox, every iOS browser. Expected, not an error.
    }
    const settled = await Promise.race([
      nav.getBattery(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!settled || typeof settled.level !== 'number' || !Number.isFinite(settled.level)) {
      return null;
    }
    return { level: Math.max(0, Math.min(1, settled.level)), charging: settled.charging === true };
  } catch (error) {
    log.error('battery read failed', error);
    return null;
  }
}

/**
 * The reading taken at activation, held for the closure request so both numbers travel together.
 *
 * Module-scoped rather than on the session record because it must survive the closure sheet being
 * opened from either skin, and it is one small value that means nothing on its own.
 */
let atTrigger: BatteryReading | null = null;

export function rememberTriggerBattery(reading: BatteryReading | null): void {
  atTrigger = reading;
}

export function getTriggerBattery(): BatteryReading | null {
  return atTrigger;
}

/** Cleared when a session ends, so a later event cannot inherit an earlier event's reading. */
export function clearTriggerBattery(): void {
  atTrigger = null;
}
