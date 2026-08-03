import { defineConfig } from 'vitest/config';

/**
 * Brief 43 §D — this package was the SECOND one outside the suite, and it was found by the guard
 * written for the first.
 *
 * `packages/classifier` is a runtime dependency of the PWA — 678 lines of keyword matching, tone
 * scoring and fusion — and it had no test script and not one test file. `pnpm -r test` reported
 * success over all of it.
 *
 * The coverage added alongside this config is DELIBERATELY MINIMAL and does not pretend
 * otherwise: it pins the scoring contract at its boundaries and drives the §C hostile-input rule
 * through the text path. Real coverage of the classification logic is a brief of its own, and
 * saying so is better than a `passWithNoTests` flag that would have turned "never tested" into a
 * green check.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
