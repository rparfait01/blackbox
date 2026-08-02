import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Brief 2 Fix A §0 — trigger latency is the constraint, and a measurement is corroboration, not
 * proof. Network noise on a staging measurement is ±20ms; a credential check that cost 5ms would
 * hide inside it. What actually guarantees §0 is that the trigger handler does not run the
 * credential path at all, and that is a property of the source, so it is asserted here.
 */
describe('§0 the trigger path is not gated by a credential check', () => {
  // The POST /v1/events handler, from its opening line to the next top-level route.
  const handler = (() => {
    const start = index.indexOf("app.post('/v1/events', async (c) => {");
    expect(start).toBeGreaterThan(-1);
    const next = index.indexOf('\napp.', start + 10);
    return strip(index.slice(start, next === -1 ? undefined : next));
  })();

  it('the trigger handler never calls device verification', () => {
    expect(handler).not.toMatch(/verifyDeviceProof/);
    expect(handler).not.toMatch(/isAccountArmed/);
    expect(handler).not.toMatch(/device_credentials/);
  });

  it('the trigger handler adds no new database read for credentials', () => {
    expect(handler).not.toMatch(/deviceCredentialArmedAt/);
  });

  it('device verification IS present on the event-scoped write, where it belongs', () => {
    // §B — the check exists; it is simply not on the path between a survivor and an alert.
    const chunk = index.slice(index.indexOf("app.post('/v1/events/:id/chunks/:sequence'"));
    expect(chunk).toMatch(/verifyDeviceProof/);
  });

  it('the only refusal on the capture path is an explicit REFUSED decision', () => {
    // Anything else — unarmed, absent, unknown, revoked-but-unarmed, skewed clock, D1 down —
    // must fall through to the upload. A survivor mid-incident cannot fix any of them.
    const chunk = strip(index.slice(index.indexOf("app.post('/v1/events/:id/chunks/:sequence'")));
    const refusals = chunk.match(/deviceVerdict\.decision === '(\w+)'/g) ?? [];
    expect(refusals).toEqual(["deviceVerdict.decision === 'REFUSED'"]);
  });
});
