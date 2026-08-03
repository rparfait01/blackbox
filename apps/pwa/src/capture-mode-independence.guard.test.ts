import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Comments describe history and must not satisfy or fail an assertion about behaviour. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Brief 50 §A — CAPTURE, TRANSCRIPTION AND CLASSIFICATION DO NOT READ PRESENT MODE.
 *
 * ═══ THIS GUARD CAUGHT NONE OF THE OBSERVED FAILURE, AND IS STILL WORTH HAVING ════════════════
 *
 * Stated plainly because it matters for how this is read. The Visible-mode failure was NOT a
 * capture module reading Present mode — §0 established that capture diverges at exactly one line
 * (`captureModeForSource`, keyed on activation SOURCE, not on Present mode) and that both real
 * defects were downstream on the coordinator's playback surface.
 *
 * What this guards is the property that made the failure so expensive to diagnose: the belief
 * that capture might differ by mode. As long as that is structurally impossible, the next
 * investigation starts downstream instead of spending its first hours where the bug is not.
 *
 * Present mode is a RENDERING property. It selects what the survivor sees — the meditation facade
 * or the direct interface — and nothing else. A capture behaviour that differs between Hidden and
 * Visible is a defect, not a configuration, per the Brief 22 / trigger-unify correction.
 */
const MODE_READERS = [
  /usePresentMode/,
  /presentMode/,
  /\bdisplayMode\b/,
  /['"]meditation['"]/,
  /['"]blackbox['"]\s*===/,
  /isHidden|isCovert|isVisible|isOvert/,
];

const GOVERNED = [
  'lib/capture/media-capture.ts',
  'lib/capture/config.ts',
  'lib/transcription/speech-recognition.ts',
  'lib/tone/tone-analyzer.ts',
];

describe('Brief 50 §A — capture is mode-independent', () => {
  it('reads the governed modules — this guard asserts its own landmarks', () => {
    for (const rel of GOVERNED) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(src.length, `${rel} not found or empty — this guard is reading nothing`).toBeGreaterThan(200);
    }
  });

  for (const rel of GOVERNED) {
    it(`${rel} does not read Present mode`, () => {
      const code = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const hits = MODE_READERS.filter((re) => re.test(code)).map(String);
      expect(
        hits,
        `${rel} reads Present mode. Capture, transcription and classification are mode-independent: ` +
          'mode selects what the survivor SEES and nothing else. If a platform genuinely requires a ' +
          'difference, it belongs behind a named capability check, not behind which screen is showing.',
      ).toEqual([]);
    });
  }

  it('capture mode is chosen by activation SOURCE, not by Present mode', () => {
    // The one legitimate divergence, pinned so it stays legible: covert activation keeps the
    // camera off. That is a source-keyed decision about what the phone reveals, not a mode-keyed
    // decision about what the app renders — and §0.1 confirmed video otherwise captures fine.
    const cfg = stripComments(readFileSync(join(SRC, 'lib/capture/config.ts'), 'utf8'));
    expect(cfg).toMatch(/captureModeForSource\s*\(\s*source/);
    expect(cfg).toMatch(/direct-tap/);
  });
});
