import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The branded entry router at `/` — and the one property that must never break.
 *
 * The installed PWA is named "Stillpoint" and its `start_url` is `/`. For a covert
 * install, opening the home-screen icon MUST show the meditation disguise. A branded
 * "BLACK BOX SENTINEL" splash there would be the loudest tell in the product, in the
 * exact moment the disguise matters most. So RootGate's covert branch is checked FIRST,
 * before anything branded can be constructed — and these pin that ordering, not merely
 * its presence.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the session check wins at the root, before any display mode is consulted', () => {
  const gate = stripComments(read('./app/RootGate.tsx'));

  it('checks for a SESSION first — earlier than any getDisplayMode() call', () => {
    // A signed-out device has no account, so it has no display mode to honour. Reading a
    // leftover one would let the previous user's preference decide what the NEXT person
    // sees — a visitor from the public site dropped into a meditation app.
    const sessionAt = gate.indexOf('getSessionToken() == null');
    const modeAt = gate.indexOf('getDisplayMode()');
    expect(sessionAt).toBeGreaterThan(-1);
    expect(modeAt).toBeGreaterThan(-1);
    expect(sessionAt, 'the session check must precede any display-mode read').toBeLessThan(modeAt);
  });

  it('the no-session branch returns the Landing and consults NOTHING else', () => {
    const branch = gate.slice(gate.indexOf('getSessionToken() == null'), gate.indexOf('getDisplayMode()'));
    expect(branch).toMatch(/<Landing \/>/);
    expect(branch, 'the signed-out branch must not read a stored skin').not.toMatch(/getDisplayMode|covert|MeditationHome/);
  });

  it('a SIGNED-IN covert install still gets the untouched facade', () => {
    expect(gate).toMatch(/getDisplayMode\(\) === 'covert'[\s\S]{0,200}MeditationHome/);
    expect(gate).toContain('ClosurePinGate');
  });

  it('the facade is unreachable without a session — the covert branch sits after the guard', () => {
    const facadeAt = gate.indexOf('MeditationHome', gate.indexOf('export function RootGate'));
    const sessionAt = gate.indexOf('getSessionToken() == null');
    expect(sessionAt).toBeLessThan(facadeAt);
  });

  it('a signed-in survivor with no role still goes STRAIGHT to the app', () => {
    // The landing must never become a toll gate on the way to the trigger screen.
    expect(gate).toMatch(/!getCachedConsoleLevel\(\)[\s\S]{0,120}to="\/blackbox"/);
  });

  it('the root decision is synchronous — no network call on the path to the app', () => {
    // An await here would put a spinner between a survivor and their armed screen, and
    // offline it would never resolve.
    expect(gate).not.toMatch(/await|useEffect|api</);
  });
});

describe('§0a the landing never appears on, or links from, a facade surface', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface imports or references the landing', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not reference the landing`).not.toMatch(/routes\/landing|<Landing|Sentinel/i);
    }
  });

  it('no facade surface renders the product wordmark', () => {
    for (const f of facades) {
      expect(stripComments(read(f)), `${f} must not name the product`).not.toMatch(/BLACK ?BOX|SENTINEL/i);
    }
  });
});

describe('the landing is an instrument surface, not a facade one', () => {
  const landing = read('./routes/landing/Landing.tsx');

  it('uses the instrument palette and never the facade tokens', () => {
    // Painting it with med-* would both look wrong and mark it as a facade surface to
    // facade-palette.guard.test.ts, which classifies files by the tokens they use.
    expect(landing).toMatch(/bg-bb-bg/);
    expect(landing).not.toMatch(/\b(text|bg|border)-med-|stillpoint-bg/);
  });

  it('carries the house wordmark: BLACK BOX ■ SENTINEL', () => {
    expect(landing).toMatch(/BLACK BOX[\s\S]{0,120}SENTINEL/);
  });

  it('does NOT reuse the app icon as a logo — those icons are the disguise', () => {
    expect(landing).not.toMatch(/icon-192|icon-512|apple-touch-icon|icons\//);
  });
});

describe('the landing routes internally — no dead ends, no external links', () => {
  const landing = read('./routes/landing/Landing.tsx');

  it('every destination is an internal Link, never an <a href> off-site', () => {
    expect(landing).not.toMatch(/<a\s+href=|https?:\/\/(?!\s)/);
    expect(landing).toMatch(/<Link/);
  });

  it('offers sign-in AND account creation when signed out — onboarding is one branch', () => {
    expect(landing).toMatch(/to="\/signin"/);
    expect(landing).toMatch(/to="\/onboarding"/);
  });

  it('offers the app, settings, and (only when roled) the console when signed in', () => {
    expect(landing).toMatch(/to="\/blackbox"/);
    expect(landing).toMatch(/to="\/settings"/);
    expect(landing).toMatch(/\{level \?[\s\S]{0,300}to="\/console"/);
  });

  it('confirms the level against the SERVER, and caches it only as a hint', () => {
    expect(landing).toMatch(/api<\{ level: string; levelLabel: string \}>\('\/v1\/console\/me'\)/);
    expect(landing).toMatch(/cacheConsoleLevel\(next\)/);
    // Signed out means no level, and the hint is cleared rather than left stale.
    expect(landing).toMatch(/if \(!signedIn\) \{[\s\S]{0,120}cacheConsoleLevel\(null\)/);
  });
});

describe('the display mode is an ACCOUNT property — sign-out drops it', () => {
  const auth = read('./lib/auth.ts');
  const fn = auth.slice(auth.indexOf('export function clearSession'), auth.indexOf('export function clearSession') + 500);

  it('clearSession deletes the mode and never writes one back', () => {
    // Keeping a mode without a session is what let a signed-out visitor reach the facade.
    expect(fn).toMatch(/del\(MODE_KEY\)/);
    expect(fn, 'no skin may survive sign-out').not.toMatch(/set\(MODE_KEY/);
  });

  it('the whole session is cleared with it', () => {
    for (const key of ['TOKEN_KEY', 'USER_KEY', 'SETUP_KEY', 'ENTITLEMENT_KEY', 'CONSOLE_KEY']) {
      expect(fn, `${key} must be deleted on sign-out`).toMatch(new RegExp(`del\\(${key}\\)`));
    }
  });

  it('sign-in restores the skin from server truth, so Hidden is not lost', () => {
    expect(auth).toMatch(/export function setSession[\s\S]{0,200}set\(MODE_KEY, mode\)/);
  });
});

describe('the console-level cache is a hint, never an authority', () => {
  const auth = read('./lib/auth.ts');

  it('only accepts the three known labels — anything else reads as no level', () => {
    expect(auth).toMatch(/v === 'DEV' \|\| v === 'ADMIN' \|\| v === 'COORD' \? v : null/);
  });

  it('is cleared on sign-out along with the session', () => {
    expect(auth).toMatch(/export function clearSession[\s\S]{0,260}del\(CONSOLE_KEY\)/);
  });
});
