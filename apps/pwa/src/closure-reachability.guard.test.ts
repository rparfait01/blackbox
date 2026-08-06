import { describe, expect, it } from 'vitest';

import { code } from '../../../test-utils/guard-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const CONTROL = code(join(SRC, 'routes', 'meditation', 'ClosureControl.tsx')) as string;

/**
 * BRIEF 56 FIX A — SHE CAN END HER ALERT WITH ONE TAP, FROM THE FIRST SCREEN.
 *
 * ═══ THE ARCHAEOLOGY ═════════════════════════════════════════════════════════════════════════
 *
 * Brief 0B governs the closure CONSENT RULE and says nothing about the interaction — its only
 * mention of the gesture defers to whatever already existed ("retains the existing duress
 * semantics of the closure gesture"). The interaction came from Brief 15 §E2 (`ec4c807`), which
 * replaced the closure pin with a press-and-hold and made that one gesture carry two payloads:
 * the request AND whether she is under duress. There was never a way to make a tap a clean
 * request, which is why 18 production closures out of 18 read as coercion.
 *
 * Brief 56 (`43d02d5`) added a 350ms floor to stop that. It stopped the false duress and made the
 * most natural interaction do nothing at all. Brief 59 added a direct close — and rendered it
 * only on the `awaiting` screen, reachable exclusively by succeeding at the gesture that was
 * broken. The way out was behind the door that was stuck.
 *
 * ═══ WHAT THIS PINS ══════════════════════════════════════════════════════════════════════════
 *
 * Not the gesture — §E2's hold and its duress semantics are untouched. What is pinned is
 * REACHABILITY: a way to end the alert exists on every screen shown while an event is live, and
 * none of them requires a gesture to have already worked.
 */
describe('the way out is never behind a door that can stick', () => {
  it('the subject exists — this guard names what it reads', () => {
    expect(CONTROL.length, 'ClosureControl read as empty').toBeGreaterThan(500);
    expect(CONTROL).toMatch(/export function ClosureControl/);
  });

  it('the direct close is on the FIRST screen, not only on awaiting', () => {
    // Two occurrences: the initial screen and the awaiting screen. One is not enough — one means
    // it is reachable only after the gesture has already succeeded.
    const occurrences = (CONTROL.match(/End the alert now/g) ?? []).length;
    expect(
      occurrences,
      'the direct close is reachable from only one screen — if that screen is behind the gesture, ' +
        'a survivor whose gesture does not register has no way out at all',
    ).toBeGreaterThanOrEqual(2);
  });

  it('it is a plain onClick — no hold, no ring, no threshold', () => {
    // The whole point is that it depends on nothing that has failed. A gesture-driven escape from
    // a broken gesture is not an escape.
    expect(CONTROL).toMatch(/onClick=\{\(\) => void endDirectly\(\)\}/);
    expect(CONTROL).toMatch(/async function endDirectly/);
  });

  it('endDirectly needs no coordinator and no confirmer', () => {
    expect(CONTROL).toMatch(/endOwnEventDirectly/);
    expect(CONTROL, 'the direct close was routed back through the consent gesture').not.toMatch(
      /endDirectly[\s\S]{0,200}submitClosureGesture/,
    );
  });

  it('§E2 is untouched — the hold still carries the duress contract', () => {
    // Fix A adds a second affordance. It does not redesign the gesture, because the gesture's
    // semantics are a safety decision and were not what broke.
    expect(CONTROL).toMatch(/outcomeForRelease/);
    expect(CONTROL).toMatch(/Press and hold until the ring completes to request closure/);
  });

  it('no screen shown during a live event lacks a way out', () => {
    // The awaiting branch is the one that trapped her: it used to render a message and nothing
    // pressable. Both live screens now carry a control.
    const awaiting = CONTROL.slice(CONTROL.indexOf(') : awaiting ? ('), CONTROL.indexOf('\n        ) : ('));
    expect(awaiting, 'the awaiting screen has no pressable control').toMatch(/<button/);
    expect(awaiting).toMatch(/Ask again/);
    expect(awaiting).toMatch(/End the alert now/);
  });
});
