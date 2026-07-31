import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  accountLevelLabel,
  codeStatus,
  codeVisibility,
  deriveConsoleLevel,
  LEVEL_LABEL,
  mayIssueCodeRole,
  navFor,
  readinessState,
  rosterVisibility,
} from '../src/lib/console-scope';
import { MIGRATIONS_AT_BUILD } from '../src/lib/migration-manifest';

/**
 * Brief 33b/33c — the console boundary, pinned.
 *
 * The live acceptance suite proves the boundary holds on the deployed surface. These
 * guards prove it cannot be UNDONE by an edit: the pure rules keep their shape, and the
 * route file keeps the properties that make those rules load-bearing — no client-supplied
 * org for a staff query, no content table anywhere, dry-run by default on anything
 * destructive, and an audit trail that names a person.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const routes = readFileSync(join(SRC, 'routes', 'console.ts'), 'utf8');
const scope = readFileSync(join(SRC, 'lib', 'console-scope.ts'), 'utf8');

// =====================================================================
// The pure rules
// =====================================================================

describe('level derivation comes from server-side facts only', () => {
  it('operator wins over any org membership — the cross-org role is never narrowed', () => {
    expect(
      deriveConsoleLevel({ platformRole: 'operator', membership: { orgId: 'org-a', role: 'admin' } }),
    ).toEqual({ level: 'operator', orgId: null });
  });

  it('a staff membership sets the level AND pins the one org it may touch', () => {
    expect(deriveConsoleLevel({ platformRole: null, membership: { orgId: 'org-a', role: 'admin' } })).toEqual({
      level: 'admin',
      orgId: 'org-a',
    });
    expect(
      deriveConsoleLevel({ platformRole: null, membership: { orgId: 'org-b', role: 'coordinator' } }),
    ).toEqual({ level: 'coordinator', orgId: 'org-b' });
  });

  it('no platform role and no membership is UNMARKED with no org', () => {
    expect(deriveConsoleLevel({ platformRole: null, membership: null })).toEqual({
      level: 'unmarked',
      orgId: null,
    });
  });

  it('an unrecognised platform role never becomes operator', () => {
    // The DB CHECK makes this unstorable, but the rule must not depend on the DB for it.
    expect(deriveConsoleLevel({ platformRole: 'admin', membership: null }).level).toBe('unmarked');
    expect(deriveConsoleLevel({ platformRole: 'OPERATOR', membership: null }).level).toBe('unmarked');
  });
});

describe('§1 the account-level indicator uses the same derivation as the gate', () => {
  it('labels each level exactly as the console displays it', () => {
    expect(accountLevelLabel({ platformRole: 'operator', membership: null })).toBe('DEV');
    expect(accountLevelLabel({ platformRole: null, membership: { orgId: 'o', role: 'admin' } })).toBe('ADMIN');
    expect(accountLevelLabel({ platformRole: null, membership: { orgId: 'o', role: 'coordinator' } })).toBe('COORD');
    expect(accountLevelLabel({ platformRole: null, membership: null })).toBe('UNMARKED');
  });

  it('the labels are display-only — the underlying field names are untouched', () => {
    expect(LEVEL_LABEL.operator).toBe('DEV');
    // 'DEV' must never appear as a stored value: the column is CHECK-constrained to
    // 'operator', so a label that leaked into a write would be unstorable.
    expect(scope).not.toMatch(/platform_role\s*=\s*'DEV'/);
  });
});

describe('code issuance is authorised by level, and admin is closed to everyone', () => {
  it('a coordinator may mint survivor codes only', () => {
    expect(mayIssueCodeRole('coordinator', 'survivor')).toBe(true);
    expect(mayIssueCodeRole('coordinator', 'coordinator')).toBe(false);
  });

  it('an admin may mint survivor and coordinator codes', () => {
    expect(mayIssueCodeRole('admin', 'survivor')).toBe(true);
    expect(mayIssueCodeRole('admin', 'coordinator')).toBe(true);
  });

  it('NOBODY — not even the operator — mints an admin ENROLLMENT code', () => {
    // Brief 24 §2: admin is reachable only through the registration ceremony. An
    // enrollment code that conferred admin would reopen that door.
    for (const level of ['operator', 'admin', 'coordinator', 'unmarked'] as const) {
      expect(mayIssueCodeRole(level, 'admin')).toBe(false);
    }
  });

  it('an unmarked account issues nothing, and unknown roles are refused', () => {
    expect(mayIssueCodeRole('unmarked', 'survivor')).toBe(false);
    expect(mayIssueCodeRole('operator', 'superuser')).toBe(false);
    expect(mayIssueCodeRole('admin', '')).toBe(false);
  });
});

describe('visibility narrows monotonically with the level', () => {
  it('codes: operator all, admin org, coordinator own, unmarked none', () => {
    expect(codeVisibility('operator')).toBe('all');
    expect(codeVisibility('admin')).toBe('org');
    expect(codeVisibility('coordinator')).toBe('own');
    expect(codeVisibility('unmarked')).toBe('none');
  });

  it('roster: the operator gets NONE — the cross-org role reads no per-person rows', () => {
    expect(rosterVisibility('operator')).toBe('none');
    expect(rosterVisibility('admin')).toBe('org');
    expect(rosterVisibility('coordinator')).toBe('own');
    expect(rosterVisibility('unmarked')).toBe('none');
  });
});

describe('the nav is built server-side, per level, with no dead ends', () => {
  it('a coordinator is never sent a Maintenance or Seats item — not hidden, ABSENT', () => {
    const keys = navFor('coordinator').map((n) => n.key);
    expect(keys).toEqual(['', 'codes', 'roster']);
    expect(JSON.stringify(navFor('coordinator'))).not.toMatch(/maintenance|seats|organization/i);
  });

  it('an admin gets its own org views and none of the operator ones', () => {
    const keys = navFor('admin').map((n) => n.key);
    expect(keys).toEqual(['', 'seats', 'codes', 'roster']);
    expect(JSON.stringify(navFor('admin'))).not.toMatch(/maintenance|organization|accounts/i);
  });

  it('the operator gets every operator view, including the one that exists', () => {
    // A view that is reachable but has no nav entry is a dead end; the account
    // level-indicator view is operator-only and must therefore be listed.
    expect(navFor('operator').map((n) => n.key)).toEqual(['', 'orgs', 'codes', 'accounts', 'maintenance']);
  });

  it('UNMARKED gets no nav at all', () => {
    expect(navFor('unmarked')).toEqual([]);
  });

  it('every level that has a nav starts with Home — the one-click way back', () => {
    for (const level of ['operator', 'admin', 'coordinator'] as const) {
      const nav = navFor(level);
      expect(nav[0]).toEqual({ key: '', label: 'Home', path: '/console' });
    }
  });

  it('every nav path is under /console and matches its key — no broken links', () => {
    for (const level of ['operator', 'admin', 'coordinator'] as const) {
      for (const item of navFor(level)) {
        expect(item.path).toBe(item.key ? `/console/${item.key}` : '/console');
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('nav breadth narrows with privilege — a lower level never gets a wider nav', () => {
    const width = (l: 'operator' | 'admin' | 'coordinator') => navFor(l).length;
    expect(width('operator')).toBeGreaterThan(width('admin'));
    expect(width('admin')).toBeGreaterThan(width('coordinator'));
  });
});

describe('readiness is operational, and an unredeemed code blames nobody', () => {
  it('armed requires BOTH activation and a reachable recipient', () => {
    expect(readinessState({ redeemed: true, activated: true, reachableRecipient: true })).toBe('armed');
    expect(readinessState({ redeemed: true, activated: true, reachableRecipient: false })).toBe('not_ready');
    expect(readinessState({ redeemed: true, activated: false, reachableRecipient: true })).toBe('not_ready');
  });

  it('an unredeemed code is its own state, never "not ready"', () => {
    expect(readinessState({ redeemed: false, activated: false, reachableRecipient: false })).toBe('not_redeemed');
  });
});

describe('code status mirrors the atomic consume conditions', () => {
  const base = { revoked: 0, expiresAt: null as number | null, maxUses: 1, usedCount: 0 };
  it('revoked beats everything', () => {
    expect(codeStatus({ ...base, revoked: 1, usedCount: 5 }, 1000)).toBe('revoked');
  });
  it('expiry and exhaustion are distinct, and a live code is active', () => {
    expect(codeStatus({ ...base, expiresAt: 500 }, 1000)).toBe('expired');
    expect(codeStatus({ ...base, usedCount: 1 }, 1000)).toBe('exhausted');
    expect(codeStatus({ ...base, expiresAt: 5000 }, 1000)).toBe('active');
  });
});

// =====================================================================
// The route file's structural properties
// =====================================================================

describe('scope is resolved server-side, per request, and never from the client', () => {
  it('the identity middleware reads the platform role and an ACTIVE membership from D1', () => {
    expect(routes).toMatch(/SELECT platform_role, name, email FROM users WHERE id = \?/);
    expect(routes).toMatch(/FROM org_members WHERE userId = \? AND status = 'active'/);
    expect(routes).toMatch(/deriveConsoleLevel\(/);
  });

  it('a session is required before any level logic runs', () => {
    const sessionAt = routes.indexOf("consoleRoutes.use('*', requireSession)");
    const identityAt = routes.indexOf('deriveConsoleLevel(');
    expect(sessionAt).toBeGreaterThan(-1);
    expect(identityAt).toBeGreaterThan(sessionAt);
  });

  it('every org-scoped handler takes its org from the session, not a body or param', () => {
    // scopedOrg() reads consoleOrgId, which only the identity middleware writes.
    expect(routes).toMatch(/function scopedOrg\([\s\S]{0,120}c\.get\('consoleOrgId'\)/);

    // [A] The operator is the only level that crosses org boundaries — so it is the only
    // level whose routes may read an org id from the request at all. Split the file into
    // route handlers and require that any handler naming a client-supplied org is gated
    // on operator. This is the guard that a future org-scoped route cannot slip past by
    // "just adding an orgId param".
    const handlers = routes.split(/\nconsoleRoutes\.(?=get|post|use)/).slice(1);
    expect(handlers.length).toBeGreaterThan(10);
    for (const handler of handlers) {
      const reads = [...handler.matchAll(/c\.req\.param\('orgId'\)|body\.orgId/g)];
      if (reads.length === 0) continue;
      const signature = handler.slice(0, handler.indexOf('async'));
      if (/requireLevel\('operator'\)/.test(signature)) continue; // operator-only route: allowed

      // A route shared with lower levels may still name an org, but ONLY inside an
      // explicit operator branch. Every read must fall within it — one that does not is a
      // path where an admin or coordinator could reach an org they were not scoped to.
      const branchStart = handler.indexOf("if (identity.level === 'operator') {");
      const branchEnd = handler.indexOf('} else {', branchStart);
      expect(branchStart, `a non-operator route reads an org from the client: ${signature}`).toBeGreaterThan(-1);
      for (const read of reads) {
        expect(read.index, `client org read outside the operator branch in: ${signature}`).toBeGreaterThan(branchStart);
        expect(read.index, `client org read outside the operator branch in: ${signature}`).toBeLessThan(branchEnd);
      }
    }
  });

  it('the operator is the only level allowed to name an org', () => {
    expect(routes).toMatch(/if \(identity\.level === 'operator'\) \{[\s\S]{0,600}body\.orgId/);
    expect(routes).toMatch(/SELECT id FROM organizations WHERE id = \?/);
  });
});

describe('[A] no level — operator included — can read incident CONTENT', () => {
  // The console must have no route that touches capture bytes, transcripts, locations,
  // case files, or the commitments that describe them. Counters and metadata only.
  const CONTENT_TABLES = [
    'chunks_index',
    'transcripts_index',
    'locations_index',
    'classifications_index',
    'case_files',
    'plaintext_commitments',
    'wrapped_keys',
    'vault_objects',
    'closure_reports',
  ];

  it('names no content table anywhere in the console routes', () => {
    for (const table of CONTENT_TABLES) {
      expect(routes, `console must never query ${table}`).not.toMatch(new RegExp(`FROM\\s+${table}\\b`, 'i'));
    }
  });

  it('never reads the media bucket for content — only a liveness probe', () => {
    // A single list({limit:1}) health probe is the ONLY MEDIA access. No get(), no body.
    expect(routes).not.toMatch(/MEDIA\.get\(/);
    expect(routes).toMatch(/MEDIA\.list\(\{ limit: 1 \}\)/);
  });

  it('reads events only as COUNTS, never as rows carrying incident detail', () => {
    // Every events query in the console is an aggregate. A SELECT of event columns would
    // be a step toward incident detail, so there is none.
    const eventSelects = routes.match(/SELECT[^;]*FROM events/gi) ?? [];
    expect(eventSelects.length).toBeGreaterThan(0);
    for (const q of eventSelects) {
      expect(q, `not an aggregate: ${q}`).toMatch(/COUNT\(\*\)/i);
    }
  });
});

describe('the roster is READINESS ONLY — no identity of any kind', () => {
  it('selects no name, email, phone or account id for an enrollee', () => {
    const roster = routes.slice(routes.indexOf('async function loadRoster'), routes.indexOf("consoleRoutes.get('/roster'"));
    // redeemedBy is read INTERNALLY to compute readiness…
    expect(roster).toMatch(/ec\.redeemedBy/);
    // …and the returned row carries only the code, the timestamp and counters.
    const returned = roster.slice(roster.lastIndexOf('return rows.map'));
    expect(returned).not.toMatch(/\bname\b|\bemail\b|\bphone\b|userId:/);
  });

  it('the RosterRow shape itself admits no identifying field', () => {
    const shape = routes.slice(routes.indexOf('interface RosterRow'), routes.indexOf('async function loadRoster'));
    expect(shape).toMatch(/code: string/);
    expect(shape).not.toMatch(/name|email|phone|userId|location/i);
  });

  it('judges readiness by the same deliverability rule the survivor’s own app uses', () => {
    expect(routes).toMatch(/isChannelDeliverable\(env, r\.channel\)/);
    expect(routes).toMatch(/consentGateEnforced\(env\)/);
    expect(routes).toMatch(/hasReachableRecipient\(/);
  });
});

describe('[A] code operations reuse the unified table and the one minter', () => {
  it('mints only through createEnrollmentCode — no second generator', () => {
    expect(routes).toMatch(/createEnrollmentCode\(/);
    expect(routes).not.toMatch(/generateReadableCode|randomHex|Math\.random/);
    expect(routes).not.toMatch(/INSERT INTO enrollment_codes/);
  });

  it('revocation applies the scope predicate INSIDE the update, not around it', () => {
    expect(routes).toMatch(/UPDATE enrollment_codes SET revoked = 1 WHERE code = \?\$\{scope\.sql\}/);
    // Out-of-scope is indistinguishable from non-existent: same 404, no oracle.
    expect(routes).toMatch(/changes !== 1[\s\S]{0,80}code_not_found/);
  });

  it('seat removal delegates to leaveOrg, so min-2-admins cannot be bypassed', () => {
    expect(routes).toMatch(/leaveOrg\(c\.env, targetId\)/);
    // Demotion is the same danger as removal and runs the same guard.
    expect(routes).toMatch(/adminRemovalBlocked\(c\.env, orgId\)/);
  });
});

describe('§3 maintenance is dry-run by default and audited to a person', () => {
  it('destructive actions require an explicit confirm:true', () => {
    const purge = routes.slice(routes.indexOf("'/maintenance/purge-media'"), routes.indexOf("'/maintenance/delete-account'"));
    const del = routes.slice(routes.indexOf("'/maintenance/delete-account'"), routes.indexOf("'/maintenance/audit'"));
    expect(purge).toMatch(/confirm: body\.confirm === true/);
    expect(del).toMatch(/confirm: body\.confirm === true/);
    // A malformed body previews; it never falls through to a deletion.
    expect(purge).toMatch(/\.catch\(\(\) => \(\{\}\)/);
    expect(del).toMatch(/\.catch\(\(\) => \(\{\}\)/);
  });

  it('every console audit names the acting user — never null, never a literal', () => {
    const audits = routes.match(/audit\(c\.env, null, [^)]*\)/g) ?? [];
    expect(audits.length).toBeGreaterThan(5);
    for (const call of audits) {
      expect(call, `audit does not name the actor: ${call}`).toMatch(/,\s*actor\s*,/);
    }
  });

  it('account deletion uses the CASCADING routine — the one that deletes R2 first', () => {
    expect(routes).toMatch(/deleteAccount\(c\.env, target\.id/);
    expect(routes).not.toMatch(/DELETE FROM users/);
  });

  it('health fails closed: an unreachable PWA is a mismatch, never "unknown"', () => {
    expect(routes).toMatch(/matched: pwa\.ok && pwa\.build != null && pwa\.build === workerBuild/);
    // Strip comments first — the doc comment legitimately names the failure mode it
    // forbids; what must be absent is 'unknown' as a VALUE the health panel can return.
    const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/'unknown'/);
    // Every probe reports its own ok; the panel is green only when all of them are.
    expect(code).toMatch(/ok: d1\.ok && r2\.ok && pwa\.ok && migrations\.ok && currency\.matched/);
  });
});

describe('the migration manifest cannot drift from the migrations directory', () => {
  it('lists exactly the migrations on disk, in order', () => {
    const onDisk = readdirSync(join(HERE, '..', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect([...MIGRATIONS_AT_BUILD].sort()).toEqual(onDisk);
    // Order matters for "latest applied" to read correctly.
    expect(MIGRATIONS_AT_BUILD).toEqual([...MIGRATIONS_AT_BUILD].sort());
  });
});
