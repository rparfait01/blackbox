import { defineConfig } from 'vitest/config';

/**
 * Brief 43 §D — packages/shared had NO test runner.
 *
 * It declared build, typecheck and lint and nothing else, so `pnpm -r test` walked straight past
 * it. The code that never ran under the suite includes the certified-report verifier: the one
 * artifact a third party runs against a survivor's evidence, in a hearing, without us present.
 * Its tests existed — in apps/pwa, because that is where a runner was — which is a coverage
 * arrangement that looks fine in a file listing and answers to nothing.
 *
 * A test that never runs is the same class as a test that cannot fail. Both report a confidence
 * no one earned, and both are invisible until the thing they were supposed to catch ships.
 *
 * `node` environment: this package is runtime-agnostic on purpose — the same source runs in the
 * Worker, in a browser, and in a court expert's own script. Testing it against a DOM would test a
 * runtime it does not target. `crypto.subtle`, `atob` and `btoa` are all Node globals.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
