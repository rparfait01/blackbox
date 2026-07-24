import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 27 §3–§4 guards — the intake flow is trauma-informed, review-gated, fail-closed,
 * and never a tell in the Hidden facade.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const intake = read('./routes/settings/GuidedIntake.tsx');

describe('§3 trauma-informed by construction', () => {
  it('Pause and Stop controls exist and are reachable', () => {
    expect(intake).toMatch(/Pause &amp; save|Pause & save/);
    expect(intake).toMatch(/pauseAndClose/);
    expect(intake).toMatch(/stopAndDiscard/);
  });

  it('NEVER auto-advances on silence — there are no timers that change the step', () => {
    expect(intake).not.toMatch(/setTimeout|setInterval/);
    // Advancing is an explicit action only: answer()/next() are the sole step-advancers,
    // and they are called synchronously from click handlers, never from a timer.
    expect(intake).toMatch(/function answer/);
    expect(intake).toMatch(/function next\(from: Step\)/);
  });

  it('never grades, scores, or challenges an answer', () => {
    // No grading VERDICTS (the reassurance copy legitimately says nothing is graded/scored).
    expect(intake).not.toMatch(/\b(correct answer|wrong answer|is incorrect|answer is wrong)\b/i);
    // And it positively reassures the survivor it does none of that.
    expect(intake).toMatch(/nothing is graded/i);
    expect(intake).toMatch(/scored, or interpreted — these are your answers/i);
  });

  it('every structured question is skippable', () => {
    expect(intake).toMatch(/Skip this question/);
  });
});

describe('§3 partial drafts are sealed + resumable, never plaintext', () => {
  it('the flow saves via saveDraft (sealed/no-op) and can resume via loadDraft', () => {
    expect(intake).toMatch(/saveDraft\(/);
    expect(intake).toMatch(/loadDraft\(/);
    expect(intake).toMatch(/Continue where you left off/);
    // It never writes a draft by any means other than the sealed saveDraft.
    expect(intake).not.toMatch(/localStorage\.setItem|putConfig/);
  });
});

describe('§4 mandatory review gate + fail-closed filing', () => {
  it('File is disabled until the survivor has reviewed', () => {
    expect(intake).toMatch(/disabled=\{!reviewed\}/);
    expect(intake).toMatch(/I've read this and it's how I want it filed/);
  });
  it('filing is fail-closed — a refused seal or a 409 goes to the blocked screen, never plaintext', () => {
    expect(intake).toMatch(/const sealed = await sealCaseFile\(record\)/);
    expect(intake).toMatch(/if \(!sealed\.ok\)[\s\S]*?setStep\('blocked'\)/);
    expect(intake).toMatch(/res\.status === 409[\s\S]*?setStep\('blocked'\)/);
    // Nothing is uploaded except the sealed blob.
    expect(intake).toMatch(/sealedCaseFile: sealed\.sealed/);
  });
});

describe('§0a the Hidden facade shows no intake', () => {
  const facades = ['./routes/meditation/MeditationHome.tsx', './routes/meditation/BreathingCircles.tsx', './routes/meditation/HoldProgressRing.tsx'];
  it('no facade surface imports or mentions the intake', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not reference the intake`).not.toMatch(/GuidedIntake|Make a report|case file|intake/i);
    }
  });
});
