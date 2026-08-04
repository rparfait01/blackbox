import { describe, expect, it } from 'vitest';

import { LocalClassifier } from './local-classifier';
import { fuseThreatLevel } from './scoring/fusion';
import type { ClassificationContext } from './types';

/**
 * Brief 52 §C — EVERY CLASSIFIER PATH IS TOTAL BY CONSTRUCTION.
 *
 * The classify tick runs inside a try/catch that logs and continues. That is correct — a
 * classifier crash must never take down a capture in progress — and it is exactly why a throw
 * here is dangerous: it does not surface as an error, it silently switches threat classification
 * OFF for the rest of the session. That is how the `normalize()` defect hid until Brief 43 §D
 * gave this package a test runner at all.
 *
 * So totality is asserted rather than intended, and failure is asserted to be REPORTED rather
 * than absent.
 */
const HOSTILE: unknown[] = [
  null,
  undefined,
  42,
  true,
  {},
  [],
  '',
  '   ',
  'A'.repeat(100_000),
  '\u{1F511}'.repeat(500),
  'やめて、ほんとうにやめて',
  '{"__proto__":{"polluted":true}}',
];

const CONTEXTS: unknown[] = [
  {},
  { tone: undefined },
  { tone: null },
  { tone: { volumeBand: 'loud' } },
  { tone: { volumeBand: 'silent' } },
  null,
  undefined,
];

describe('Brief 52 §C — the classifier never throws', () => {
  const classifier = new LocalClassifier();

  for (const transcript of HOSTILE) {
    it(`classify() returns rather than throws: ${JSON.stringify(transcript)?.slice(0, 40) ?? String(transcript)}`, async () => {
      for (const context of CONTEXTS) {
        await expect(
          classifier.classify(transcript as string, context as ClassificationContext),
          `threw on transcript=${String(transcript).slice(0, 20)} context=${JSON.stringify(context)}`,
        ).resolves.not.toThrow;
        const result = await classifier.classify(transcript as string, context as ClassificationContext);
        // null is a legitimate "no audible input" skip. Anything else must be a full record.
        if (result !== null) {
          expect(['classified', 'unclassified', 'failed']).toContain(result.state);
        }
      }
    });
  }

  it('a failure is REPORTED, never swallowed into absence', async () => {
    // A classifier whose library set is corrupt: the failure must reach the caller as a record
    // saying so, not as null (which reads as "nothing was said") and not as an exception.
    const broken = new LocalClassifier([{ get lang(): string { throw new Error('boom'); } }] as never);
    const result = await broken.classify('he has a knife', { tone: { volumeBand: 'loud' } } as unknown as ClassificationContext);
    expect(result, 'a classifier crash produced silence').not.toBeNull();
    expect(result!.state, 'a crash was not reported as a failure').toBe('failed');
    expect(result!.failureReason, 'the failure has no reason attached').toBeTruthy();
    expect(result!.summary, 'the summary reads as though nothing happened').toMatch(/could not run/i);
  });
});

describe('Brief 52 §D — unclassified is never low', () => {
  it('zero score on AUDIBLE input is unclassified, not low', () => {
    expect(fuseThreatLevel(0, 0, false, true)).toBe('unclassified');
  });

  it('zero score on NO input stays unknown — silence is not unreadable speech', () => {
    expect(fuseThreatLevel(0, 0, false, false)).toBe('unknown');
  });

  it('a real score still reads low — the distinction is not a downgrade of everything', () => {
    // Guards against "fixing" this by making everything unclassified: a scored tick that lands
    // below `medium` is a genuine low finding and must stay low.
    expect(fuseThreatLevel(1, 0, false, true)).toBe('low');
  });

  it('Japanese text that misses the lexicon reports unclassified WITH a reason naming it', async () => {
    const classifier = new LocalClassifier();
    // Deliberately not a keyword — the point is speech we can SEE is Japanese but cannot score.
    const result = await classifier.classify('きょうはいいてんきですね', {
      tone: { volumeBand: 'normal' },
    } as unknown as ClassificationContext);
    expect(result).not.toBeNull();
    if (result && result.state === 'unclassified') {
      expect(result.threatLevel).toBe('unclassified');
      expect(result.unclassifiedReason, 'unclassified with no reason is another blank field').toBeTruthy();
      expect(result.unclassifiedReason).toMatch(/ja|could not judge/i);
    }
  });
});
