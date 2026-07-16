import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Everybody has somebody" §2 tripwire — setup is the ONLY place the contact
 * requirement is enforced, so this file is what keeps the guarantee honest.
 *
 * Two failures are pinned here, and they pull in opposite directions:
 *
 *  1. Setup completing with zero contacts — a live account whose alert reaches
 *     nobody, and the survivor would never know.
 *  2. The requirement leaking onto the TRIGGER — the far worse failure. A panic
 *     button that refuses to fire in an active threat is the one thing this
 *     product cannot ship. §2 buys the guarantee at setup precisely so the button
 *     never has to be gated. If a future edit "enforces" this at activation, that
 *     is a regression to a dead button, and these assertions must fail.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§2 setup cannot complete without a contact', () => {
  const onboarding = read('./routes/onboarding/Onboarding.tsx');

  it('has NO skip affordance on the add-contact step', () => {
    expect(onboarding).not.toMatch(/Skip\s*—\s*add later/i);
    // No clickable escape that jumps past the contact step. (Prose mentioning
    // "skip" is fine — what must not exist is an affordance that bypasses it.)
    expect(onboarding).not.toMatch(/onClick=\{\(\)\s*=>\s*setStep\(7\)\}/);
  });

  it('completion is gated on a confirmed contact save', () => {
    expect(onboarding).toContain('const resolved = permsResolved && contactSaved');
  });

  it('contactSaved flips only on a CONFIRMED save, never on intent', () => {
    // It must be set inside the res.ok branch of saveSupport (and on LINE connect),
    // never optimistically before the request resolves.
    expect(onboarding).toMatch(/if \(res\.ok\) \{[\s\S]{0,160}setContactSaved\(true\)/);
  });

  it('states the requirement in plain copy', () => {
    expect(onboarding).toMatch(/Add at least one person who should be notified if you trigger/i);
  });

  it('names the missing contact as the blocker, not the microphone', () => {
    expect(onboarding).toMatch(/Add a contact to continue/);
  });
});

describe('§2 the requirement NEVER reaches the trigger', () => {
  it('the activation core has no contact/recipient gate', () => {
    const activation = read('./lib/activation/index.ts');
    expect(activation).not.toMatch(/armable/i);
    expect(activation).not.toMatch(/contactSaved|recipientCount|hasDeliverableRecipient/);
  });

  it('Visible wires the tap to the core with no armable gate in the handler', () => {
    const home = read('./routes/blackbox/BlackBoxHome.tsx');
    // The disc's double-tap dispatches unconditionally (Brief 22 §1 / Brief 30).
    expect(home).toContain("useDoubleTap(() => void triggerAlert('direct-tap'))");
    // A zero-contact account must never have the activate affordance disabled.
    expect(home).not.toMatch(/disabled=\{[^}]*armable/);
  });
});
