import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 17 §0 tripwire — the visibility toggle's mapping is LOAD-BEARING and must
 * never invert: Hidden = covert (Stillpoint facade), Visible = overt (instrument).
 * If wired backwards, a user choosing Hidden would get the instrument screen in
 * front of an aggressor — the worst-case failure. These assertions read the
 * source so a future edit that inverts the mapping, reverts the relabel, or
 * reintroduces the unreliable window.confirm fails here instead of shipping.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§0 visibility toggle — relabel + pinned mapping', () => {
  const settings = read('./routes/settings/Settings.tsx');

  it('is relabeled to a two-ended Hidden / Visible control (no "Present")', () => {
    expect(settings).toMatch(/>\s*Hidden\s*</);
    expect(settings).toMatch(/>\s*Visible\s*</);
    expect(settings).not.toMatch(/label="Present"/);
  });

  it('maps Hidden → covert and Visible → direct (never inverted)', () => {
    // The Hidden affordance applies covert; the Visible affordance applies direct.
    expect(settings).toContain("applyMode('covert')");
    expect(settings).toContain("applyMode('direct')");
    // The hidden branch must resolve to covert (the safe default direction).
    expect(settings).toMatch(/target === 'hidden'[\s\S]{0,80}applyMode\('covert'\)/);
  });

  it('does not gate the switch behind the native confirm dialog (unreliable in the installed PWA)', () => {
    // Scope to the visibility code path (applyMode + selectVisibility); the
    // delete-account double-confirm legitimately uses window.confirm elsewhere.
    const visRegion = settings.slice(
      settings.indexOf('async function applyMode'),
      settings.indexOf('async function setRegion'),
    );
    expect(visRegion.length).toBeGreaterThan(50);
    expect(visRegion).not.toContain('window.confirm');
  });

  it('renders the SELECTED mode on leaving Settings (Brief 31 §3 — no in-place teleport)', () => {
    // Selecting a mode persists it (setDisplayMode) but does NOT navigate; goBack
    // then routes to the selected mode's screen, so the rendered mode matches the
    // stored/selected mode with no reload and no mid-task jump.
    expect(settings).toContain('setDisplayMode(mode)');
    expect(settings).toMatch(/goBack[\s\S]{0,140}selectedMode === 'direct' \? '\/blackbox' : '\/'/);
    expect(settings).not.toContain('window.location.assign');
  });
});

describe('§0 RootGate renders the mode the toggle sets', () => {
  const rootGate = read('./app/RootGate.tsx');
  it('covert → Stillpoint facade; direct → instrument (/blackbox)', () => {
    // Covert is now the only mode named explicitly — direct is the fall-through — so the
    // PINNED mapping is asserted by where each branch leads, not by a literal 'direct'.
    expect(rootGate).toMatch(/getDisplayMode\(\) === 'covert'[\s\S]{0,200}MeditationHome/);
    expect(rootGate).toContain('to="/blackbox"');
    expect(rootGate).toContain('MeditationHome');
  });

  it('the mapping is never inverted: covert must not route to the instrument', () => {
    // A survivor choosing Hidden must NEVER get the instrument (the load-bearing rule).
    const covertBranch = rootGate.slice(
      rootGate.indexOf("getDisplayMode() === 'covert'"),
      rootGate.indexOf('to="/blackbox"'),
    );
    expect(covertBranch).toContain('MeditationHome');
    expect(covertBranch).not.toContain('to="/blackbox"');
  });
});
