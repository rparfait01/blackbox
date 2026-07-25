/**
 * Brief 29 §-1 / §3 — the server-side non-negotiables, pinned structurally.
 *
 * Two promises this brief makes to the outside world that prose cannot keep on its own:
 *
 *   THE VERIFIER NEVER STORES THE DOCUMENT. It is checked in the visitor's browser and
 *   never uploaded. If a fetch, an upload endpoint, or a D1/R2 write ever appeared on this
 *   path, that promise would quietly become false. These assertions make it loud.
 *
 *   THE VERIFICATION PAGE IS A LEAF. Nothing in the running system depends on it, and it
 *   stays dark until zero-knowledge custody is armed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe('§3 [A] the verifier never stores the uploaded document', () => {
  it('the verification page neither uploads nor persists anything', () => {
    const page = read('lib/verification-page.ts');
    // No network call out of the page, and no upload endpoint to send a document to.
    expect(page).not.toMatch(/fetch\(|XMLHttpRequest|navigator\.sendBeacon|FormData/);
    // No persistence of any kind.
    expect(page).not.toMatch(/localStorage|sessionStorage|indexedDB|env\.DB|env\.MEDIA|env\.VAULT|INSERT INTO/);
  });

  it('there is NO endpoint that accepts a report document — nothing to store it with', () => {
    const index = read('index.ts');
    expect(index).not.toMatch(/app\.post\(['"]\/v1\/report\/verify/);
    expect(index).not.toMatch(/app\.post\(['"]\/verification/);
  });

  it('the page states plainly that the file stays on the visitor’s device', () => {
    const page = read('lib/verification-page.ts');
    expect(page).toMatch(/Your file stays on your device/);
    expect(page).toMatch(/never uploaded/);
  });

  it('it publishes the key + algorithm so a court can verify without the page', () => {
    const page = read('lib/verification-page.ts');
    expect(page).toMatch(/Verify independently, without this page/);
    expect(page).toMatch(/Ed25519 over the canonical JSON/);
    expect(page).toMatch(/Published public key/);
  });
});

describe('§-1 [A] the verification page is a LEAF', () => {
  it('only the route registration references it — nothing else in the system does', () => {
    const importers = allSources().filter((f) => {
      if (f.endsWith('verification-page.ts')) return false;
      return /verification-page/.test(readFileSync(f, 'utf8'));
    });
    expect(importers.map((f) => relative(SRC, f))).toEqual([join('index.ts')]);
  });

  it('the page imports nothing operational — it cannot reach the running system', () => {
    const page = read('lib/verification-page.ts');
    const specifiers = [...page.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual([]);
  });

  it('is loaded lazily, so it is not even in the hot path’s module graph', () => {
    expect(read('index.ts')).toMatch(/await import\('\.\/lib\/verification-page'\)/);
  });
});

describe('§5 / ACCEPTANCE — flag-gated dormancy', () => {
  it('/verification 404s unless zero-knowledge custody is armed', () => {
    const index = read('index.ts');
    const route = index.slice(index.indexOf("app.get('/verification'"), index.indexOf("app.get('/verification'") + 900);
    expect(route).toMatch(/ENVELOPE_ENCRYPTION_ENABLED !== 'true'/);
    expect(route).toMatch(/return c\.notFound\(\)/);
  });

  it('every report endpoint 404s while the flag is down', () => {
    const user = read('routes/user.ts');
    expect(user).toMatch(/function reportsOff[\s\S]*?envelopeEnabled\(c\.env\) \? null : c\.json\(\{ error: 'not_found' \}, 404\)/);
    // Each of the four report routes consults the gate before doing anything.
    for (const route of [
      "userRoutes.get('/reports/events'",
      "userRoutes.get('/reports/events/:id/metadata'",
      "userRoutes.get('/reports/events/:id/chunks/:sequence'",
      "userRoutes.post('/reports/sign'",
    ]) {
      const at = user.indexOf(route);
      expect(at, `${route} must exist`).toBeGreaterThan(-1);
      expect(user.slice(at, at + 400), `${route} must check the gate first`).toMatch(/const off = reportsOff\(c\);/);
    }
  });
});

describe('§5 org and operator are never in the path', () => {
  it('no org or admin route can reach a report', () => {
    for (const file of allSources()) {
      const rel = relative(SRC, file);
      if (!/routes[\\/](org|org-register)\.ts$/.test(rel)) continue;
      expect(readFileSync(file, 'utf8'), `${rel} must not touch reports`).not.toMatch(/report-attestation|reports\//);
    }
    // The admin surface in index.ts has no report route either.
    expect(read('index.ts')).not.toMatch(/\/v1\/admin\/[a-z-]*report/);
  });

  it('report reads are owner-scoped by construction', () => {
    const metadata = read('lib/report-metadata.ts');
    // Every export takes a userId and filters on it — there is no unscoped read.
    expect(metadata).toMatch(/WHERE userId = \?/);
    expect(metadata).toMatch(/WHERE id = \? AND userId = \?/);
    expect(metadata).not.toMatch(/orgId/);
  });
});

describe('§2 [A] the signing key stays server-side', () => {
  it('signing reuses the shipped integrity key — no second key system', () => {
    const attestation = read('lib/report-attestation.ts');
    expect(attestation).toMatch(/from '\.\/integrity'/);
    expect(attestation).not.toMatch(/generateKey|importKey|INTEGRITY_SIGNING_KEY/);
  });

  it('the sign endpoint accepts hashes only — never report content', () => {
    const user = read('routes/user.ts');
    const at = user.indexOf("userRoutes.post('/reports/sign'");
    const route = user.slice(at, user.indexOf('// Brief 27 §5 Destination 1', at));
    expect(route).toMatch(/\{ eventId\?: string; evidenceHash\?: string; renderedHash\?: string \}/);
    expect(route).toMatch(/\/\^\[0-9a-f\]\{64\}\$\//); // hashes are shape-checked
    expect(route).not.toMatch(/evidence\b(?!Hash)|narrative|statement|plaintext/);
  });
});
