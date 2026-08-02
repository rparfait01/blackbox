import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Brief 30 Fix A — a handle is not a credential.
 *
 * These assert the SHAPE of the fix in source, because the behavioural proof is an integration
 * test against a deployed worker (acceptance suite checks). What is guarded here is that the
 * defect cannot quietly return: a route that reads `body.signupId` as authorization again would
 * reopen a full account-takeover path, and it would look perfectly reasonable in review.
 */
describe('§A no endpoint accepts a bare handle as authorization', () => {
  const auth = strip(read('workers/api/src/routes/auth.ts'));

  it('no route derives a userId from body.signupId', () => {
    // THE DEFECT, exactly: `const userId = sessionUserId ?? body.signupId ?? null`. Proven on
    // staging to return a valid session for an already-active account with no credential at all.
    expect(auth).not.toMatch(/body\.signupId/);
    expect(auth).not.toMatch(/signupId\s*\?\?\s*null/);
  });

  it('every signup step verifies a scoped capability instead', () => {
    for (const scope of ['signup:finalize', 'signup:passkey', 'signup:recovery']) {
      expect(auth, `missing scope ${scope}`).toContain(scope);
    }
    expect(auth).toMatch(/requireCapability\(c, body, 'signup:finalize'\)/);
    expect(auth).toMatch(/capabilitySubject\(c, body, 'signup:passkey'\)/);
    expect(auth).toMatch(/capabilitySubject\(c, body, 'signup:recovery'\)/);
  });

  it('finalize refuses an account that is already active', () => {
    // The check that was missing entirely. Without it, finalize on a live account re-runs and
    // mints a session — and silently flips displayMode, which for a covert user removes the
    // disguise the product exists to provide.
    expect(auth).toMatch(/if \(isActive\(user\)\) \{/);
    expect(auth).toMatch(/already_finalized/);
    expect(auth).toMatch(/signup\.finalize_refused_already_active/);
  });
});

describe('§B binding and single use', () => {
  const cap = read('workers/api/src/lib/signup-capability.ts');
  const auth = strip(read('workers/api/src/routes/auth.ts'));

  it('the capability is bound to a client nonce, by commitment not by value', () => {
    // The first cut bound to the STORED enrollment code — a value the client cannot reproduce —
    // so verification compared the commitment against undefined and refused every capability,
    // including legitimate ones. A gate that refuses everyone is the §D lockout, not a gate.
    expect(auth).toMatch(/bind: body\.bindNonce \? await bindingFor\(c\.env, body\.bindNonce\) : null/);
    expect(auth).toMatch(/hmacSha256Hex\(key, `bind\.\$\{nonce\}`\)/);
    // and it is actually PRESENTED at verification, which is the half that was missing
    expect(auth).toMatch(/bind: await presentedBinding\(c\.env, body\)/);
  });

  it('an absent nonce does not lock anyone out', () => {
    // bind null ⇒ binding not enforced. The capability is still signed, scoped, expiring and
    // single-use; the binding is defence in depth, never the thing standing between a person
    // and an account.
    expect(read('workers/api/src/lib/signup-capability.ts')).toMatch(/if \(claims\.bind && opts\.bind !== claims\.bind\)/);
  });

  it('replay of a consumed capability is rejected AND audited', () => {
    expect(auth).toMatch(/consumeCapability\(c\.env, cap\.claims\)/);
    expect(auth).toMatch(/signup\.capability_replayed/);
    expect(auth).toMatch(/capability_replayed/);
  });

  it('single use is enforced by a primary key, not a read-then-write', () => {
    // Two concurrent replays race on the INSERT; only one can win. A SELECT-then-INSERT would
    // let both through under exactly the conditions an attacker would create.
    expect(cap).toMatch(/INSERT OR IGNORE INTO consumed_capabilities/);
    expect(read('workers/api/migrations/0053_consumed_capabilities.sql')).toMatch(/jti\s+TEXT PRIMARY KEY/);
  });
});

describe('§C the token never travels where it can be copied', () => {
  it('capabilities are read from the request body, never a query string', () => {
    const auth = read('workers/api/src/routes/auth.ts');
    expect(auth).not.toMatch(/c\.req\.query\(['"]capability['"]\)/);
    expect(auth).toMatch(/verify a capability from the REQUEST BODY only/);
  });

  it('audit rows carry the identifier and scope, never the token', () => {
    const cap = read('workers/api/src/lib/signup-capability.ts');
    expect(cap).toMatch(/export function auditableCapability/);
    const body = cap.slice(cap.indexOf('export function auditableCapability'));
    expect(body).toMatch(/jti: claims\.jti/);
    expect(body).not.toMatch(/token/);
  });
});

describe('§D/§E lockout, clock skew and rotation', () => {
  const cap = read('workers/api/src/lib/signup-capability.ts');

  it('the lifetime is stated with its reasoning, and it is generous', () => {
    // A broken gate blocks account creation, and the person blocked may be in danger.
    expect(cap).toMatch(/CAPABILITY_TTL_MS = 60 \* 60 \* 1000/);
    expect(cap).toMatch(/LOCKOUT IS WORSE THAN EXPIRY/);
  });

  it('expiry is a named, recoverable outcome — never a dead end', () => {
    expect(cap).toMatch(/'capability_expired'/);
    expect(cap).toMatch(/self-service restart/);
  });

  it('§E1 — expiry is judged on SERVER time only', () => {
    // A device with a wrong clock must still be able to create an account.
    expect(cap).toMatch(/server time, always/);
    expect(cap).toMatch(/§E1 — server time only/);
    // no client-supplied timestamp is ever read into the decision
    expect(strip(cap)).not.toMatch(/body\.(iat|exp|now|timestamp)/);
  });

  it('§E3 — rotation does not lock out an in-flight signup', () => {
    // Verification accepts the previous key until in-flight capabilities expire; minting always
    // uses the current one. The alternative is a deploy that ejects everyone mid-onboarding.
    expect(cap).toMatch(/SIGNUP_CAPABILITY_SECRET_PREVIOUS/);
    expect(cap).toMatch(/for \(const key of keys\)/);
    expect(cap).toMatch(/const \[key\] = capabilityKeys\(env\)/); // mint = current only
  });

  it('signature comparison is constant-time', () => {
    expect(cap).toMatch(/function timingSafeEqual/);
    expect(cap).toMatch(/diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
  });

  it('a misconfigured environment refuses rather than degrading to no gate', () => {
    // The failure mode to avoid is a capability scheme that silently becomes optional.
    expect(cap).toMatch(/server_misconfigured/);
    expect(cap).toMatch(/is not a gate/);
  });
});
