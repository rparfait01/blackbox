import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fix Brief 15 §A tripwire — the Stillpoint facade palette.
 *
 * The covert facade (login + dormant-covert + every `med`-themed surface) must
 * read as a genuine, calming wellness app: a deep blue-green wash, soft teal/aqua
 * text, gentle teal rings. It must contain NO amber and NO alarm red — those are
 * the instrument's signature colors and their appearance on a facade surface both
 * breaks the cover and is exactly the leak §A exists to prevent.
 *
 * Simultaneously, §A must NOT move a single pixel of the OVERT instrument theme
 * (true black / amber / red), which lives in the `bb` and `status` tokens.
 *
 * These assertions read the source as text (no import side effects) so a future
 * edit that reintroduces amber/red onto the facade — or that disturbs the
 * instrument tokens — fails here instead of shipping.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

// The instrument's forbidden-on-facade colors.
const AMBER = ['#D4A373', '#E89A00', /\bamber\b/i] as const;
const ALARM_RED = ['#FF3B30', 'status-active'] as const;
// Retired facade colors that must never reappear (old navy/purple/cream).
const RETIRED = ['#1a1f3a', '#2d1f4a', '#1f2d4a', '#F4EDE0', '#D4A373'] as const;

describe('Brief 15 §A — facade palette tokens', () => {
  const tw = read('../tailwind.config.ts');
  // Isolate the `med:` facade-palette block from the rest of the config.
  const medBlock = tw.slice(tw.indexOf('med: {'), tw.indexOf('}', tw.indexOf('med: {')));

  it('facade palette is the calm deep blue-green / teal set', () => {
    expect(medBlock).toContain("bg1: '#0a1d22'");
    expect(medBlock).toContain("bg3: '#071416'");
    expect(medBlock).toContain("text: '#8fd6cc'");
    expect(medBlock).toContain("accent: '#3f7d78'");
  });

  it('facade palette contains no amber and no alarm red', () => {
    for (const a of AMBER) expect(medBlock).not.toMatch(a as RegExp & string);
    for (const r of ALARM_RED) expect(medBlock).not.toContain(r);
  });

  it('OVERT instrument tokens are untouched (no pixels moved)', () => {
    expect(tw).toContain("bg: '#000000'"); // bb.bg true black
    expect(tw).toContain("armed: '#E89A00'"); // status.armed amber
    expect(tw).toContain("active: '#FF3B30'"); // status.active alarm red
    expect(tw).toContain("ack: '#34C759'");
  });

  it('the Stillpoint gradient is the blue-green wash, not the retired navy/purple', () => {
    const css = read('./index.css');
    const grad = css.slice(css.indexOf('.stillpoint-bg'), css.indexOf('}', css.indexOf('.stillpoint-bg')));
    expect(grad).toContain('#0a1d22');
    expect(grad).toContain('#071416');
    for (const old of RETIRED) expect(grad).not.toContain(old);
  });
});

/** Walk every source file and classify facade surfaces by token usage. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('Brief 15 §A — no instrument color leaks onto any facade surface', () => {
  const files = walk(SRC).filter((f) => !f.endsWith('facade-palette.guard.test.ts'));
  // A facade surface is anything painted with the `med` theme or the Stillpoint
  // background. The overt instrument (routes/blackbox, dashboard) is excluded by
  // construction: it never references these tokens.
  const facade = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /\bstillpoint-bg\b/.test(src) || /\b(text|bg|border)-med-/.test(src);
  });

  it('finds the facade surfaces (sanity: the set is non-empty)', () => {
    expect(facade.length).toBeGreaterThan(5);
  });

  it.each(facade.map((f) => relative(SRC, f)))('%s carries no amber, alarm red, or retired hex', (rel) => {
    const src = read(rel);
    expect(src, 'instrument alarm red leaked onto facade').not.toContain('status-active');
    expect(src, 'retired facade navy leaked').not.toContain('#1a1f3a');
    for (const old of RETIRED) expect(src).not.toContain(old);
  });
});

describe('Brief 15 §A — activation gesture survives the recolor', () => {
  it('the breathing circle still wires the covert activation trigger', () => {
    const home = read('./routes/meditation/MeditationHome.tsx');
    expect(home).toContain('useActivationHold');
    expect(home).toContain('triggerActivation');
  });
});
