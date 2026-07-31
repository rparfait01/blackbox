import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 21 tripwires — deploy currency (§1) + runtime currency (§2). These read the
 * build config, the deploy script, and the SW updater as source so a future edit
 * that unpins the deploy target, drops the currency assertion, reintroduces a
 * Hidden-visible update banner, or stops cleaning stale caches fails here instead
 * of shipping a stale-client regression.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PWA = join(HERE, '..'); // apps/pwa
const ROOT = join(PWA, '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

describe('§1 deploy currency', () => {
  const deployPages = read(join(ROOT, 'scripts/deploy-pages.mjs'));
  const assertCurrency = read(join(ROOT, 'scripts/assert-currency.mjs'));
  const pwaPkg = JSON.parse(read(join(PWA, 'package.json')));
  const vite = read(join(PWA, 'vite.config.ts'));

  it('deploy:pages runs the guarded script, never a bare wrangler pages deploy', () => {
    expect(pwaPkg.scripts['deploy:pages']).toContain('deploy-pages.mjs');
    expect(pwaPkg.scripts['deploy:pages']).not.toMatch(/wrangler pages deploy/);
  });

  it('pins the deploy target to the production branch (no Preview-only path)', () => {
    expect(deployPages).toContain('--branch=');
    // Brief 35 §B moved the target out of this script and into TRACKED config, so the
    // origin the artifact is built against and the origin currency is asserted against
    // cannot disagree. The pin follows the value: the branch must still be resolved from
    // the deploy target (never a literal someone can retype) AND that target must still
    // be the production branch.
    expect(deployPages).toMatch(/PROD_BRANCH\s*=\s*TARGET\.pagesBranch/);
    const targets = JSON.parse(read(join(ROOT, 'config/deploy-targets.json')));
    expect(targets.production.pagesBranch).toBe('master');
  });

  it('§35 refuses to publish an artifact with no API origin in it', () => {
    // The failure this closes: `.env` is gitignored, so a build on a clean machine had an
    // EMPTY api origin — no event created, nobody notified, nothing uploaded — and the
    // deploy went green because build ids matched. The origin must be validated from
    // tracked config and PROVEN present in the bytes about to be published.
    expect(deployPages).toMatch(/deployTarget\('production'\)/);
    expect(deployPages).toMatch(/assertOriginInArtifact/);
    expect(deployPages).toMatch(/process\.exit\(1\)/);
    const targets = JSON.parse(read(join(ROOT, 'config/deploy-targets.json')));
    expect(targets.production.apiOrigin).toMatch(/^https:\/\//);
  });

  it('the production BUILD itself fails without a valid origin — not a warning, not a fallback', () => {
    // Gate one: vite refuses to compile. Gated on the mode flag, never on the variable
    // being absent — absence used to mean "quietly disable the product".
    expect(vite).toMatch(/assertProductionApiOrigin/);
    expect(vite).toMatch(/assertApiOrigin\(value, 'production build'\)/);
    expect(vite).toMatch(/mode !== 'production'/);
    // Gate two: env.ts has no empty-string fallback left to fall back to. The exact
    // defect — `export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '')` —
    // must not be able to come back, and the resolver must keep BOTH the dev branch and
    // the fatal one.
    const env = read(join(PWA, 'src/lib/env.ts'));
    expect(env).not.toMatch(/export const API_BASE_URL\s*=\s*\(import\.meta\.env/);
    expect(env).toMatch(/export const API_BASE_URL = resolveApiBaseUrl\(\);/);
    expect(env).toMatch(/if \(import\.meta\.env\.DEV\)/);
    expect(env).toMatch(/throw new Error\(/);
  });

  it('delegates currency to the hardened guard — no soft/inline worker path', () => {
    expect(deployPages).toMatch(/assertDeployCurrencyOrExit/);
    // The old warn-only, worker-skipping path must never come back (the defect was
    // `let worker = 'unknown'` + a console.warn; match the code form, not prose).
    expect(deployPages).not.toMatch(/console\.warn/);
    expect(deployPages).not.toMatch(/=\s*'unknown'/);
  });

  // Brief 0 — BOTH halves hard-fail; an unreachable worker fails CLOSED.
  it('fails loud (non-zero); the worker half is not a warn and not a skip', () => {
    expect(assertCurrency).toContain('process.exit(1)');
    expect(assertCurrency).not.toMatch(/console\.warn/); // no soft worker warning
    expect(assertCurrency).not.toMatch(/=\s*'unknown'/); // no 'unknown' fallback/skip
  });

  it('an unreachable/erroring endpoint fails closed (ok:false), never swallowed to success', () => {
    expect(assertCurrency).toMatch(/catch[\s\S]*?seen =/); // errors are recorded, not ignored
    expect(assertCurrency).toMatch(/return \{ ok: false/); // and yield a hard failure
  });

  it('verifies BOTH halves against the LIVE endpoints, cache-busted', () => {
    expect(assertCurrency).toMatch(/version\.json/); // PWA live endpoint
    expect(assertCurrency).toMatch(/'build'/); // PWA field
    expect(assertCurrency).toMatch(/'version'/); // worker field
    expect(assertCurrency).toMatch(/cache: 'no-store'/);
    expect(assertCurrency).toMatch(/\?ts=/);
  });

  it('prints success ONLY after both halves verify (the exit gate precedes it)', () => {
    const successIdx = assertCurrency.indexOf('both match the committed build');
    const exitIdx = assertCurrency.indexOf('process.exit(1)');
    expect(successIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(exitIdx);
  });

  it('emits version.json at build time so the live build is fetchable', () => {
    expect(vite).toContain('version.json');
    expect(vite).toMatch(/emitVersionJson|emitFile/);
  });
});

describe('§2 runtime currency (service worker)', () => {
  const vite = read(join(PWA, 'vite.config.ts'));
  const updater = read(join(PWA, 'src/components/UpdateBanner.tsx'));

  it('SW claims clients and purges outdated caches on activate', () => {
    expect(vite).toMatch(/clientsClaim:\s*true/);
    expect(vite).toMatch(/cleanupOutdatedCaches:\s*true/);
  });

  it('checks for a newer build on foreground/resume, not only on an interval', () => {
    expect(updater).toContain('visibilitychange');
    expect(updater).toMatch(/registration\.update|\.update\(\)/);
  });

  it('applies updates only while dormant and defers during a live alert', () => {
    expect(updater).toMatch(/waiting && !alertActive/);
    expect(updater).toContain('SKIP_WAITING');
  });

  it('NEVER renders an update banner/indicator — no tell in Hidden (§0a)', () => {
    // The component is headless: it must return null and carry no banner copy.
    expect(updater).toMatch(/:\s*null\s*\{/); // signature returns null
    expect(updater).not.toMatch(/A new version is ready/);
    expect(updater).not.toMatch(/<button/);
    expect(updater).not.toMatch(/Reload</);
  });
});
