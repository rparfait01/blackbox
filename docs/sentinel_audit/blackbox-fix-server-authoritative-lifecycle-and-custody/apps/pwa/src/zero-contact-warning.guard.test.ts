import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Everybody has somebody" §3 tripwire — the standing zero-contact warning.
 *
 * Three properties, all load-bearing:
 *  1. A zero-contact account IS warned, in Visible and in Settings. Settings is the
 *     only place a Hidden-primary user can ever be warned.
 *  2. The warning NEVER blocks the trigger. It informs. A user with no contacts may
 *     still be in danger and must still be able to fire and record.
 *  3. §0a — it NEVER appears in the Hidden facade. A warning banner on the covert
 *     screen is a tell, and a tell in front of an aggressor is the failure the whole
 *     facade exists to prevent.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const WARNING = /No one will be notified if you trigger/i;

describe('§3 the warning is surfaced where it can be seen', () => {
  it('Visible main screen warns when no one is reachable', () => {
    const home = read('./routes/blackbox/BlackBoxHome.tsx');
    expect(home).toMatch(WARNING);
    // Conditional on the recipient state — not permanently pinned on-screen. Brief 28
    // §2 split the arm preconditions, so the recipient warning now keys on
    // !hasRecipient (activation is a separate, distinct prompt).
    expect(home).toContain('!hasRecipient ? (');
  });

  it('Settings warns — the only channel to a Hidden-primary user', () => {
    const tabs = read('./routes/settings/ContactTabs.tsx');
    expect(tabs).toMatch(WARNING);
    expect(tabs).toContain('!data.armable');
  });

  it('both say capture still happens — the warning is not a threat to withhold recording', () => {
    expect(read('./routes/blackbox/BlackBoxHome.tsx')).toMatch(/still record/i);
    expect(read('./routes/settings/ContactTabs.tsx')).toMatch(/still record/i);
  });
});

describe('§3 the warning NEVER blocks the trigger', () => {
  const home = read('./routes/blackbox/BlackBoxHome.tsx');

  it('the activate disc is never disabled by the recipient state', () => {
    expect(home).not.toMatch(/disabled=\{[^}]*armable/);
    expect(home).not.toMatch(/if \(!armable\)\s*\{?\s*return/);
  });

  it('the tap dispatches to the core unconditionally', () => {
    expect(home).toContain("useDoubleTap(() => void triggerAlert('direct-tap'))");
  });
});

describe('§0a the Hidden facade carries no warning — no tell', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface mentions contacts, notification, or reachability', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not warn — it would be a tell`).not.toMatch(WARNING);
      expect(src, `${f} must not reference armable`).not.toMatch(/armable/);
      expect(src, `${f} must not mention notifying`).not.toMatch(/notified|no contacts|add a contact/i);
    }
  });
});
