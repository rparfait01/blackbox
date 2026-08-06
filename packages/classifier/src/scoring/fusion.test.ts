import { describe, expect, it } from 'vitest';

import { fuseThreatLevel } from './fusion';

describe('tone alone is not a judgement — the live 93ebe889 case', () => {
  it('whisper with NO keyword match is unclassified, never low', () => {
    // Measured: threatLevel `low`, matchedCategories [], toneIndicators ["whisper"]. A green LOW
    // badge over a capture in which not one word was understood. Brief 52 §D only covered a ZERO
    // score, and whisper weighs 0.5 — the hole was never at zero.
    expect(fuseThreatLevel(0, 0.5, false, true)).toBe('unclassified');
  });

  it('any tone combination without words stays unclassified', () => {
    // elevated-volume + multi-speaker + rapid-speech = 3.5, which used to clear `medium`.
    expect(fuseThreatLevel(0, 3.5, false, true)).toBe('unclassified');
    expect(fuseThreatLevel(0, 2.5, true, true)).toBe('unclassified');
  });

  it('one understood word still reads low — the meaning of low is unchanged', () => {
    expect(fuseThreatLevel(2, 0, false, true)).toBe('low');
  });

  it('words plus tone still escalate normally', () => {
    expect(fuseThreatLevel(5, 1, false, true)).toBe('high');
    expect(fuseThreatLevel(5, 3, false, true)).toBe('critical');
  });

  it('no audible input at all is still unknown, not unclassified', () => {
    expect(fuseThreatLevel(0, 0, false, false)).toBe('unknown');
  });
});
