import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 0B §5 tripwire — the live-alert lock is honest, and stays silent in Hidden.
 *
 * When Settings is opened during an active alert, VISIBLE mode must SAY so
 * ("Unavailable during an active alert") instead of silently loading then
 * bouncing the user out with no explanation. But §0a holds: that notice names an
 * active alert, so it must NEVER render in the Hidden facade — there the lock
 * bounces silently back to the breathing screen.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§5 the live-alert lock states why, in Visible', () => {
  const settings = read('./routes/settings/Settings.tsx');

  it('renders the honest lock copy', () => {
    expect(settings).toMatch(/Unavailable during an active alert/);
  });

  it('shows the notice only in VISIBLE (direct) mode; covert still bounces silently', () => {
    // The honest notice is gated behind direct mode…
    expect(settings).toMatch(/getDisplayMode\(\) === 'direct'[\s\S]*<ActiveAlertLock/);
    // …and the non-direct path is a silent Navigate to the facade root.
    expect(settings).toMatch(/return <Navigate to="\/" replace \/>/);
  });

  it('does not silently bounce Visible out of the lock (no direct-mode Navigate in the lock branch)', () => {
    // The old behavior navigated to /blackbox with no message; the notice replaces it.
    expect(settings).not.toMatch(/Navigate to=\{getDisplayMode\(\) === 'direct' \? '\/blackbox'/);
  });
});

describe('§0a the active-alert notice is never a tell in the Hidden facade', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface renders the lock notice copy', () => {
    // The rendered notice is the tell we guard against — a source COMMENT that the
    // gear is locked during an alert is not rendered and is fine.
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not render the active-alert lock notice`).not.toMatch(
        /Unavailable during an active alert/i,
      );
    }
  });
});
