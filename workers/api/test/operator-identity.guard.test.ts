/**
 * Brief 33a — operator identity, pinned structurally.
 *
 * The gate now has TWO ways in (bearer ADMIN_TOKEN, or a session on an account whose
 * platform_role is 'operator'). Two doors is exactly when a gate quietly becomes three,
 * so these assert the shape of the check rather than trusting it stays right:
 *
 *   - a session alone is NOT enough; the account must carry the operator role
 *   - the role is read SERVER-SIDE from the users row, never from the token
 *   - nothing but 'operator' is accepted, and the DB CHECK makes other values unstorable
 *   - the operator is recorded, so an audited action names a person and not a secret
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const MIG = join(HERE, '..', 'migrations');
const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
const gate = index.slice(index.indexOf("app.use('/v1/admin/*'"), index.indexOf("interface AdminContactBody"));

describe('the admin gate accepts a token OR an operator session — and nothing else', () => {
  it('still accepts ADMIN_TOKEN (scripts and CI have no session)', () => {
    expect(gate).toMatch(/const expected = c\.env\.ADMIN_TOKEN;/);
    expect(gate).toMatch(/provided === expected/);
  });

  it('accepts a session ONLY when the account carries platform_role = operator', () => {
    expect(gate).toMatch(/verifySession\(secret, provided\)/);
    expect(gate).toMatch(/SELECT platform_role FROM users WHERE id = \?/);
    expect(gate).toMatch(/platform_role === 'operator'/);
  });

  it('reads the role from the DATABASE, never from the token', () => {
    // The token carries userId/issuedAt/signature and nothing else. A role claimed by a
    // token would be a role the holder could mint.
    const roleFromToken = /session\.(platform_role|role)/.test(gate);
    expect(roleFromToken).toBe(false);
  });

  it('refuses when neither path authorises — one exit, no fallthrough', () => {
    expect(gate).toMatch(/if \(!authorized\) \{[\s\S]*?return c\.json\(\{ error: 'unauthorized' \}, 401\);/);
  });

  it('records WHICH operator acted, so the action is attributable to a person', () => {
    expect(gate).toMatch(/c\.set\('operatorUserId', actorUserId\)/);
  });
});

describe('the role column cannot hold anything but operator', () => {
  const migration = readFileSync(join(MIG, '0042_platform_role.sql'), 'utf8');

  it('is CHECK-constrained at the database, not merely by convention', () => {
    expect(migration).toMatch(/CHECK \(platform_role IS NULL OR platform_role IN \('operator'\)\)/);
  });

  it('defaults to NULL — no existing account is silently promoted', () => {
    expect(migration).not.toMatch(/DEFAULT\s+'operator'/i);
    expect(migration).toMatch(/ALTER TABLE users ADD COLUMN platform_role TEXT/);
  });

  it('is separate from org_members.role — platform scope is not a tenant role', () => {
    // Assert the SQL, not the prose: the comment legitimately explains WHY the column is
    // not part of org_members, so strip comments before checking it touches that table.
    const sql = migration.replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/org_members/i);
  });
});

describe('the grant names exactly the intended accounts', () => {
  const grant = readFileSync(join(MIG, '0043_grant_operator.sql'), 'utf8');

  it('promotes only the two named operator accounts', () => {
    expect(grant).toMatch(/developer@blackboxsentinel\.com/);
    expect(grant).toMatch(/royce\.parfait@outlook\.com/);
    // A WHERE that could match more than the named addresses would be a mass promotion.
    expect(grant).not.toMatch(/WHERE\s+1|LIKE\s+'%|WHERE\s+platform_role IS NULL/i);
  });

  it('is idempotent — re-running sets the same value', () => {
    expect(grant).toMatch(/SET\s+platform_role = 'operator'/);
    expect(grant).not.toMatch(/INSERT/i);
  });
});
