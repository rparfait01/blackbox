import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 22 tripwires — both triggers are TAP-to-activate, and the Visible tap has
 * no blocking gate. Read as source so a future edit that reintroduces the
 * `!armable` early-return (silent Visible refusal) or restores the fragile
 * press-and-hold on the facade fails here instead of shipping.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§1 Visible — tap always fires (no blocking gate)', () => {
  const home = read('./routes/blackbox/BlackBoxHome.tsx');
  const activate = home.slice(home.indexOf('const activate'), home.indexOf('const activate') + 900);

  it('activate() dispatches unconditionally — no `if (!armable) return`', () => {
    expect(activate).toContain("triggerActivation('direct-tap')");
    expect(activate).not.toMatch(/if \(!armable\)\s*\{?\s*return/);
  });

  it('the activate disc is never disabled/dimmed on !armable', () => {
    expect(home).not.toMatch(/disabled=\{!armable/);
    expect(home).not.toMatch(/!armable && !alertActive \? 'opacity-40'/);
  });
});

describe('§2 Hidden — covert trigger is a double-tap, not press-and-hold', () => {
  const home = read('./routes/meditation/MeditationHome.tsx');

  it('detects the double-tap on POINTERDOWN (not click — unreliable on iOS touch)', () => {
    expect(home).toMatch(/onPointerDown=\{onFacadeTap\}/);
    expect(home).not.toMatch(/onClick=\{onFacadeTap\}/);
    expect(home).toContain("triggerActivation('stillpoint-press')");
    expect(home).toContain('DOUBLE_TAP_MS');
  });

  it('uses touch-action: manipulation on the trigger element (kills double-tap-zoom)', () => {
    expect(home).toContain('touch-manipulation');
  });

  it('the press-and-hold gesture is retired (no useActivationHold / progress ring)', () => {
    expect(home).not.toContain('useActivationHold');
    expect(home).not.toContain('HoldProgressRing');
  });
});

describe('§25 trigger→close→trigger — no dedup against a STALE local active session', () => {
  const act = read('./lib/activation/index.ts');

  it('reconciles a local active session against server truth before deduping', () => {
    // A local 'active' session in the dedup window is verified against the server;
    // a genuinely-closed one is cleared and the trigger falls through to create.
    expect(act).toContain('isLocalSessionStillActive');
    expect(act).toContain('fetchEventStatus');
    expect(act).toMatch(/updateSessionStatus\(existing\.id, 'closed'/);
  });
});
