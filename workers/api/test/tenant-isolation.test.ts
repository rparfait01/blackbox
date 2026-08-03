import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { roleSatisfies } from '../src/lib/org';

/**
 * Brief 23 §2 — tenant isolation machinery (the paramount property). Org A must
 * NEVER reach org B by any route. The full cross-tenant proof is the live acceptance
 * suite; these guards pin the SOURCE-level invariants so a future edit can't quietly
 * unscope the org surface: scope is resolved server-side from the account, never the
 * client; a revoked membership loses access immediately; least privilege holds.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, '..', p), 'utf8');

describe('§2 least-privilege role rule (pure)', () => {
  it('admin satisfies both admin- and coordinator-level requirements', () => {
    expect(roleSatisfies('admin', 'admin')).toBe(true);
    expect(roleSatisfies('coordinator', 'admin')).toBe(true);
  });
  it('coordinator satisfies coordinator-level only, never admin-level', () => {
    expect(roleSatisfies('coordinator', 'coordinator')).toBe(true);
    expect(roleSatisfies('admin', 'coordinator')).toBe(false);
  });
});

describe('§2 requireSession resolves orgId server-side from the account', () => {
  const auth = read('src/auth.ts');

  it('orgId is looked up from the users row, never read from the token', () => {
    // ASSERTS THE INVARIANT, NOT THE SQL STRING. This used to match
    // `SELECT sessionsValidFrom, orgId FROM users WHERE id = ?` verbatim and broke when Brief 42
    // §C added a revocation subquery to the same statement — a change that does not touch where
    // orgId comes from. What matters: orgId is SELECTed from users and set from that row, and is
    // never parsed out of the token.
    expect(auth).toMatch(/orgId[\s\S]{0,120}FROM users WHERE id = \?/);
    expect(auth).toMatch(/c\.set\('orgId', u\?\.orgId \?\? null\)/);
    // The token is verified for identity only — nothing about tenancy is read out of it.
    const afterVerify = auth.slice(auth.indexOf('await verifySession'), auth.indexOf("c.set('userId'"));
    expect(afterVerify).not.toMatch(/session\.orgId|token[\s\S]{0,40}orgId/);
  });
});

describe('§2 requireOrgRole gates /v1/org/* by active membership, not the client', () => {
  const auth = read('src/auth.ts');

  it('requires an ACTIVE org_members row (a revoked member loses access immediately)', () => {
    expect(auth).toMatch(/FROM org_members WHERE userId = \? AND status = 'active'/);
  });

  it('sets orgId + orgRole from the membership row, never from request input', () => {
    expect(auth).toMatch(/c\.set\('orgId', member\.orgId\)/);
    expect(auth).toMatch(/c\.set\('orgRole', member\.role\)/);
    // The role check is the pure rule, and a non-member is refused 403.
    expect(auth).toMatch(/roleSatisfies\(required, member\.role\)/);
    expect(auth).toMatch(/not_an_org_member/);
  });
});

describe('§2 events are stamped with the owner org at creation (frozen, join-free)', () => {
  const index = read('src/index.ts');

  it('POST /v1/events resolves the owner orgId and stores it on the event row', () => {
    // ONE owner lookup, and both stamps come out of it. Brief 35 added `isCanary` to the
    // same SELECT rather than a second query: this is the trigger path, and the org stamp
    // and the test flag must be read from the same row at the same instant — two lookups
    // could disagree, and each extra round trip here is latency on the one request a
    // survivor cannot afford to have slowed down.
    expect(index).toMatch(/SELECT orgId, isCanary FROM users WHERE id = \?/);
    expect(index).toMatch(/INSERT INTO events \([^)]*\borgId\b/);
  });
});

describe('§5 every /v1/org read is scoped by the caller org — no cross-tenant path', () => {
  const org = read('src/routes/org.ts');

  it('Track lists only this org (WHERE u.orgId = ?, bound to the session orgId)', () => {
    expect(org).toMatch(/FROM users u WHERE u\.orgId = \?/);
    expect(org).toMatch(/const orgId = c\.get\('orgId'\)!/);
  });

  it('Correlate list + detail filter by the stamped events.orgId', () => {
    expect(org).toMatch(/WHERE e\.orgId = \? AND e\.status = 'active'/);
    // Detail: the AND e.orgId = ? predicate is the isolation boundary (else 404).
    expect(org).toMatch(/WHERE e\.id = \? AND e\.orgId = \?/);
  });

  it('remove-seat only touches an account in the caller org (target.orgId === orgId)', () => {
    expect(org).toMatch(/target\.orgId !== orgId/);
  });

  it('there is no org read that binds a client-supplied org id', () => {
    // orgId always comes from c.get('orgId') (membership), never req body/param/query.
    expect(org).not.toMatch(/orgId\s*=\s*(body|c\.req\.(param|query))/);
  });
});
