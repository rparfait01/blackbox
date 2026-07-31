import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 28 §6 (server) — entitlement gates ARM, NEVER the trigger/capture/dispatch.
 *
 * The server tripwire: no entitlement token may appear in the event-open handler, the
 * per-event capture routes, or the notification dispatcher. index.ts DOES legitimately
 * reference entitlement (the ADMIN grant/revoke + the /v1/me arm affordance), so we slice
 * the specific handlers rather than grepping the whole file.
 */
const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, '..', p), 'utf8');

describe('§0 POST /v1/events (the trigger) reads no entitlement', () => {
  const index = read('src/index.ts');
  const start = index.indexOf("app.post('/v1/events'");
  const handler = index.slice(start, start + 4500);

  it('the handler exists and never references entitlement', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).not.toMatch(/entitle/i);
    expect(handler).not.toMatch(/isEntitled/);
  });

  it('the button always fires (recording-only deliverable trace, not a gate)', () => {
    expect(handler).toContain('THE BUTTON ALWAYS FIRES');
  });
});

describe('§0 the capture upload routes read no entitlement', () => {
  const index = read('src/index.ts');
  // The chunk + location + wrapped-key uploads — the capture path proper.
  for (const route of ["/v1/events/:id/chunks/:sequence", "/v1/events/:id/locations", "/v1/events/:id/wrapped-keys"]) {
    it(`${route} handler references no entitlement`, () => {
      const start = index.indexOf(`app.post('${route}'`);
      expect(start).toBeGreaterThan(-1);
      const handler = index.slice(start, start + 2500);
      expect(handler).not.toMatch(/entitle/i);
    });
  }
});

describe('§0 the dispatcher reads no entitlement', () => {
  it('lib/notify.ts never gates delivery on entitlement', () => {
    expect(read('src/lib/notify.ts')).not.toMatch(/entitle/i);
  });
});

describe('§2 the grant is one-way — never downgrades, never re-locks', () => {
  const ent = read('src/lib/entitlement.ts');
  it("grantEntitlement only flips FROM unactivated (WHERE entitlement != 'activated')", () => {
    expect(ent).toMatch(/UPDATE users SET entitlement = 'activated'[\s\S]*?WHERE id = \? AND entitlement != 'activated'/);
  });
  it('the ONLY path that writes unactivated is the explicit operator revoke', () => {
    // Every "SET ... entitlement = 'unactivated'" must live in operatorRevokeEntitlement.
    const revokeIdx = ent.indexOf('operatorRevokeEntitlement');
    const writes = [...ent.matchAll(/entitlement = 'unactivated'/g)];
    expect(writes.length).toBe(1);
    // and it appears after the revoke function declaration
    expect(ent.indexOf("entitlement = 'unactivated'")).toBeGreaterThan(revokeIdx);
  });
});
