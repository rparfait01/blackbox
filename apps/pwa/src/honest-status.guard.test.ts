import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { activeStatusLine, type DeliveryStatus } from '@/lib/active-alert';

/**
 * "Everybody has somebody" §1 tripwire — the active-alert status line must state
 * the TRUTH about who is being reached.
 *
 * The failure this pins is specific and dangerous: a survivor triggers, no one is
 * actually reachable, and the screen says "contacts are being notified." That is
 * false comfort on a safety tool — it could keep someone in a room they would
 * otherwise leave. The status line must therefore be DERIVED from the server's
 * real delivery result, never hardcoded, and no state may ever resolve to the
 * success string unless someone is genuinely being notified.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const SUCCESS = 'Contacts are being notified';
const status = (over: Partial<DeliveryStatus> = {}): DeliveryStatus => ({
  coordinatorPathFailed: false,
  recipientCount: 1,
  allChannelsFailed: false,
  ...over,
});

describe('§1 honest active status — derived, never false comfort', () => {
  it('says contacts are being notified ONLY when recipients exist and nothing has failed', () => {
    expect(activeStatusLine(status({ recipientCount: 1 }))).toBe(SUCCESS);
    expect(activeStatusLine(status({ recipientCount: 5 }))).toBe(SUCCESS);
  });

  it('zero recipients → honest "no contacts", and still states recording', () => {
    const line = activeStatusLine(status({ recipientCount: 0 }));
    expect(line).not.toBe(SUCCESS);
    expect(line).toMatch(/no contacts to notify/i);
    // Capture continues and must be stated truthfully — the trigger still fired.
    expect(line).toMatch(/recording/i);
  });

  it('all channels failed → loud honest failure, never a success string (Brief 23 §2)', () => {
    const line = activeStatusLine(status({ recipientCount: 3, allChannelsFailed: true }));
    expect(line).not.toBe(SUCCESS);
    expect(line).toMatch(/could not reach/i);
  });

  it('unknown (first poll in flight / fetch failed) claims nothing about reach', () => {
    const line = activeStatusLine(null);
    expect(line).not.toBe(SUCCESS);
    // "Recording" is true in every state, so it is the only safe unknown answer.
    expect(line).toMatch(/^Recording$/);
  });

  it('NO input state can produce the success string without a live recipient', () => {
    for (const allChannelsFailed of [true, false]) {
      for (const coordinatorPathFailed of [true, false]) {
        const line = activeStatusLine(status({ recipientCount: 0, allChannelsFailed, coordinatorPathFailed }));
        expect(line, `recipientCount=0 must never claim notification`).not.toBe(SUCCESS);
      }
    }
  });
});

describe('§1 the status line is wired to real data, not a constant', () => {
  const home = read('./routes/blackbox/BlackBoxHome.tsx');

  it('BlackBoxHome renders the derived line, not a hardcoded claim', () => {
    expect(home).toContain('activeStatusLine(delivery)');
    // The old hardcoded string must not survive as literal JSX text.
    expect(home).not.toMatch(/^\s*Contacts are being notified\s*$/m);
  });

  it('reads the server delivery truth', () => {
    expect(home).toContain('useDeliveryStatus()');
  });
});

describe('§0a the Hidden facade shows no status under any recipient state', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
  ];

  it('no facade surface renders a status line or delivery state', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not surface delivery status`).not.toContain('activeStatusLine');
      expect(src, `${f} must not poll delivery status`).not.toContain('useDeliveryStatus');
      expect(src, `${f} must not name recipients`).not.toMatch(/being notified|no contacts to notify|could not reach/i);
    }
  });
});
