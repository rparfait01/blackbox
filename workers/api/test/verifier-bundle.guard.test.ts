/**
 * Brief 29 §-1 [A] — "reuses, never re-implements", enforced for the verification page.
 *
 * The page checks documents in the visitor's browser, which means the verifier has to be
 * present as page script. That script is BUNDLED from the one shared verifier rather than
 * hand-written a second time. A stale bundle would silently reintroduce exactly the problem
 * the rule exists to prevent: the page verifying by different logic than everything else.
 *
 * So this regenerates the bundle from source and fails if the committed file has drifted.
 *   Fix with:  pnpm -F @blackbox/api build:verifier
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bundleVerifier, renderModule } from '../scripts/build-verifier.mjs';
import { VERIFIER_BUNDLE } from '../src/generated/verifier-bundle';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, '..', 'src', 'generated', 'verifier-bundle.ts');

describe('the committed verifier bundle is in sync with the shared source', () => {
  it('regenerates byte-identically', async () => {
    const fresh = renderModule(await bundleVerifier());
    const committed = readFileSync(GENERATED, 'utf8');
    expect(
      committed.replace(/\r\n/g, '\n'),
      'verifier bundle is stale — run: pnpm -F @blackbox/api build:verifier',
    ).toBe(fresh.replace(/\r\n/g, '\n'));
  }, 30_000);

  it('actually contains the shared verifier, not a stub', () => {
    expect(VERIFIER_BUNDLE).toContain('verifyReportDocument');
    expect(VERIFIER_BUNDLE).toContain('BLACK BOX CERTIFIED');
    expect(VERIFIER_BUNDLE).toContain('TAMPERED');
    expect(VERIFIER_BUNDLE.length).toBeGreaterThan(2000);
  });

  it('carries no network or storage call into the page', () => {
    // The verifier is pure: parse, hash, check. Anything else would break the promise that
    // a visitor's document never leaves their machine.
    expect(VERIFIER_BUNDLE).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|localStorage|indexedDB/);
  });
});
