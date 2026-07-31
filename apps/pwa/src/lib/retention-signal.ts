/**
 * Retention signalling (Brief 36 §D) — how the survivor is told whether her recording is
 * actually being kept, in each Present mode.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: honest-status is locked. The app never indicates
 * retention that is not happening. If the bytes are not being retained, both surfaces say
 * so — one in words, one in cadence.
 *
 * ── OVERT ──────────────────────────────────────────────────────────────────────────────
 * A plain-language warning. Nothing clever: "Your recording may not be saved."
 *
 * ── COVERT ─────────────────────────────────────────────────────────────────────────────
 * The signal IS the breathing cadence, and nothing else. No icon, no badge, no banner, no
 * colour change. Any ADDITIVE element breaks the Stillpoint facade — a thing that appears
 * only when something is wrong is itself the tell to anyone reading over her shoulder.
 *
 * BOTH STATES ARE POSITIVE. Steady cadence means retained; altered cadence means not
 * retained. The circle never stops and nothing is ever removed, because signalling by
 * ABSENCE is worthless under stress: an app that has gone still is indistinguishable from
 * an app that has crashed, been closed, or lost its session.
 *
 * THE ALTERATION STAYS PLAUSIBLE. Every duration below sits inside the range real breathing
 * practices actually use — coherent breathing at ~10s a cycle, box breathing nearer 16s,
 * 4-7-8 slower still. Someone who does not know the mapping sees a meditation app with a
 * breathing pace, which is what it is.
 *
 * THE MAPPING IS PER-ACCOUNT. Chosen once and stored on the device. There is deliberately
 * NO universal tell: learning that one person's app slows down when evidence is at risk
 * tells you nothing about anyone else's, because for half the mappings it speeds up
 * instead. That is why the set below varies the DIRECTION and not merely the amount.
 *
 * HANDLING: this mechanism must never appear in public-safe or pre-patent documentation.
 * A published tell is not a tell. It is described here, in the code that implements it,
 * and nowhere else.
 */

import { useEffect, useState } from 'react';

import { getStoredCadenceIndex, setStoredCadenceIndex } from '@/lib/storage/user-config';
import { onEncryptionStateChange, type DegradationState } from '@/lib/upload/encryption-state';

/** Whether evidence is actually being retained. Derived, never asserted by a caller. */
export type RetentionState = 'RETAINED' | 'NOT_RETAINED';

export interface Cadence {
  /** Breathing cycle length while evidence IS being retained. */
  steadyMs: number;
  /** Breathing cycle length while it is NOT. Both are ordinary meditation paces. */
  alteredMs: number;
}

/**
 * The set. Small, fixed, and deliberately mixed in direction — two mappings slow down when
 * retention fails and two speed up, so the direction of change carries no meaning across
 * accounts. Every value is a pace a real breathing exercise uses.
 */
export const CADENCES: readonly Cadence[] = [
  { steadyMs: 10_000, alteredMs: 14_000 }, // coherent → slower, toward box breathing
  { steadyMs: 14_000, alteredMs: 10_000 }, // the same pair, inverted
  { steadyMs: 12_000, alteredMs: 8_000 }, // moderate → brisker
  { steadyMs: 8_000, alteredMs: 12_000 }, // and its inverse
];

/** The default cycle, matching the CSS `animate-breathe` duration, so an account with no
 *  mapping yet looks exactly like the facade always has. */
export const DEFAULT_CADENCE: Cadence = { steadyMs: 10_000, alteredMs: 14_000 };

/**
 * Choose this account's mapping. Called at onboarding; idempotent, so calling it again
 * never re-rolls an existing account onto a new tell. Chosen at random rather than derived
 * from anything about the account — a mapping derived from a userId would be recoverable by
 * anyone who knows the derivation.
 */
export async function ensureCadenceMapping(): Promise<Cadence> {
  const existing = await getStoredCadenceIndex();
  if (typeof existing === 'number' && existing >= 0 && existing < CADENCES.length) {
    return CADENCES[existing]!;
  }
  const index = crypto.getRandomValues(new Uint32Array(1))[0]! % CADENCES.length;
  await setStoredCadenceIndex(index);
  return CADENCES[index]!;
}

/** Read the mapping without assigning one. Falls back to the facade's own default. */
export async function getCadenceMapping(): Promise<Cadence> {
  const existing = await getStoredCadenceIndex();
  if (typeof existing === 'number' && existing >= 0 && existing < CADENCES.length) {
    return CADENCES[existing]!;
  }
  return DEFAULT_CADENCE;
}

/** NONE means retained; anything else means the bytes are at risk or already lost. */
export function retentionFor(degradation: DegradationState): RetentionState {
  return degradation === 'NONE' ? 'RETAINED' : 'NOT_RETAINED';
}

/**
 * Subscribe to the capture pipeline's degradation axis. Returns RETAINED until something
 * says otherwise — and the state machine only ever says otherwise when on-device buffering
 * has ACTUALLY failed, never merely because encryption is still preparing.
 */
export function useRetentionState(): RetentionState {
  const [state, setState] = useState<RetentionState>('RETAINED');
  useEffect(() => onEncryptionStateChange((_id, record) => setState(retentionFor(record.degradation))), []);
  return state;
}

/** The covert surface's only output: how long one breath takes, right now. */
export function useBreathingCycleMs(): number {
  const retention = useRetentionState();
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE);
  useEffect(() => {
    void getCadenceMapping().then(setCadence);
  }, []);
  return retention === 'RETAINED' ? cadence.steadyMs : cadence.alteredMs;
}
