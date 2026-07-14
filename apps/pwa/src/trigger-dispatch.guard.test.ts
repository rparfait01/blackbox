import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 30 tripwires — ONE trigger core, two gesture inputs, mode as display-only.
 * Read as source so a future edit that reintroduces a second trigger path, a
 * per-mode local-session dedup / reconcile, a mode-switch trigger-state reconcile,
 * the `!armable` gate, or the fragile press-and-hold fails here instead of shipping.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const act = read('./lib/activation/index.ts');
const vis = read('./routes/blackbox/BlackBoxHome.tsx');
const hid = read('./routes/meditation/MeditationHome.tsx');
const hook = read('./lib/use-double-tap.ts');
const settings = read('./routes/settings/Settings.tsx');

describe('Brief 30 — exactly ONE trigger core', () => {
  it('the core is triggerAlert(); the dual-path name is gone', () => {
    expect(act).toContain('export async function triggerAlert');
    expect(act).not.toContain('function triggerActivation');
  });

  it('is server-authoritative: no local-session dedup, no reconcile layer', () => {
    expect(act).not.toContain('isLocalSessionStillActive');
    expect(act).not.toContain('reconcileToServerDormancy');
    expect(act).not.toContain('resetToDormant');
    expect(act).not.toContain('DEDUP_WINDOW_MS');
    // The ONLY guard is the in-page active/starting flag (module-scoped, reload-reset).
    expect(act).toMatch(/if \(active \|\| starting\)/);
  });
});

describe('Brief 30 — two gesture inputs call the one core', () => {
  it('both skins wire a double-tap to triggerAlert via the shared detector', () => {
    expect(vis).toContain("triggerAlert('direct-tap')");
    expect(vis).toContain('useDoubleTap');
    expect(hid).toContain("triggerAlert('stillpoint-press')");
    expect(hid).toContain('useDoubleTap');
  });

  it('there is ONE double-tap detection, on pointerdown (not click)', () => {
    expect(hook).toContain('onPointerDown');
    expect(hook).toContain('DOUBLE_TAP_MS');
    // Neither skin carries its own inline detection any more.
    expect(hid).not.toContain('onFacadeTap');
    expect(hid).not.toContain('DOUBLE_TAP_MS');
  });
});

describe('Brief 30 — mode is display-only', () => {
  it('the mode switch is a plain navigate with no trigger-state reconcile', () => {
    const applyMode = settings.slice(
      settings.indexOf('async function applyMode'),
      settings.indexOf('async function applyMode') + 900,
    );
    expect(applyMode).toContain('window.location.assign');
    expect(applyMode).not.toContain('reconcileToServerDormancy');
    expect(applyMode).not.toContain('closeAllActiveSessions');
  });
});

describe('preserved invariants', () => {
  it('Visible has no !armable gate (Brief 22)', () => {
    expect(vis).not.toMatch(/if \(!armable\)\s*\{?\s*return/);
    expect(vis).not.toMatch(/disabled=\{!armable/);
  });

  it('Hidden retains no press-and-hold (Brief 22/24)', () => {
    expect(hid).not.toContain('useActivationHold');
    expect(hid).not.toContain('HoldProgressRing');
  });

  it('trigger targets use touch-action: manipulation', () => {
    expect(vis).toContain('touch-manipulation');
    expect(hid).toContain('touch-manipulation');
  });
});
