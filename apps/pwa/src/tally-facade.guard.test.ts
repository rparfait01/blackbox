import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 25 §7 + §5 guards — the anonymous tally never leaks into the covert facade,
 * carries no free-text input, and always gets per-submission consent showing the
 * literal payload with the "can't be taken back" statement.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§0a/§7 the Hidden facade shows no tally, and no path to it', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];
  it('no facade surface mentions the tally or imports it', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not mention the tally`).not.toMatch(/tally|report anonymously|anonymous(ly)? (report|incident)/i);
      expect(src, `${f} must not import the tally`).not.toMatch(/AnonymousTally/);
    }
  });
});

describe('§2 the tally UI has NO free-text input — every answer is a closed choice', () => {
  const tally = read('./routes/settings/AnonymousTally.tsx');
  it('renders no <input>, <textarea>, or contentEditable anywhere', () => {
    expect(tally).not.toMatch(/<input/i);
    expect(tally).not.toMatch(/<textarea/i);
    expect(tally).not.toMatch(/contentEditable/i);
  });
  it('sends only the four closed fields — no notes/text/description key in the payload', () => {
    const body = tally.slice(tally.indexOf("api<"), tally.indexOf('if (res.ok)'));
    expect(body).toMatch(/kind:/);
    expect(body).toMatch(/roughlyWhen:/);
    expect(body).toMatch(/regionId:/);
    expect(body).toMatch(/reportedOfficial:/);
    expect(body).not.toMatch(/\b(notes?|freeText|description|comment|message|detail)\b/i);
  });
});

describe('§5 per-submission consent shows the literal payload and irreversibility', () => {
  const tally = read('./routes/settings/AnonymousTally.tsx');
  it('states it is anonymous and cannot be taken back', () => {
    expect(tally).toMatch(/This is anonymous/i);
    expect(tally).toMatch(/can’t be taken back|cannot be taken back|can't be taken back/i);
  });
  it('shows exactly what will be sent (the literal four values)', () => {
    expect(tally).toMatch(/Exactly what will be sent/i);
    expect(tally).toMatch(/labelFor\(draft\.kind\)/);
    expect(tally).toMatch(/labelFor\(draft\.reportedOfficial\)/);
  });
  it('cancel is available (not a forced one-way flow)', () => {
    expect(tally).toMatch(/Cancel/);
    expect(tally).toMatch(/onClose/);
  });
  it('surfaces a rate-limit honestly — never a silent "counted"', () => {
    // A 429 routes to the "Not counted" state, not the success state.
    expect(tally).toMatch(/res\.status === 429/);
    expect(tally).toMatch(/Not counted/);
  });
});
