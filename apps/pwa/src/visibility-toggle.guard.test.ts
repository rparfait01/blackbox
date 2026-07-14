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
  it("direct → instrument (/blackbox); covert → Stillpoint facade", () => {
    expect(rootGate).toMatch(/getDisplayMode\(\) === 'direct'/);
    expect(rootGate).toContain("to=\"/blackbox\"");
    expect(rootGate).toContain('MeditationHome');
  });
});
