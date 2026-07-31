import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TRUSTED_SIGNERS,
  TRUST_SET_VERSION,
  evaluateSigner,
  fingerprintSpki,
  type TrustedSigner,
} from '@blackbox/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/**
 * Brief 39 — a package must not vouch for itself.
 *
 * THE DEFECT. `verifyReportSignature(canonicalize(attestation), payload.signature,
 * payload.publicKey)` — verification used the key the document handed it. Anyone able to
 * produce a package could generate a keypair, sign with it, bundle the public half, and
 * obtain `certified`. The old defence was an OPTIONAL `expectedPublicKey` parameter, which
 * only the verification page passed; every other caller self-verified. Optional was the hole.
 *
 * Now the pinned set is the DEFAULT and widening it requires writing an override at the call
 * site. Forgetting the parameter tightens the check instead of disabling it — the inverse of
 * what it replaced.
 */
describe('§A the package key is never the authority', () => {
  const verifySrc = readFileSync(join(ROOT, 'packages/shared/src/report-verify.ts'), 'utf8');

  it('the signature is checked against OUR copy of the key, not the presented bytes', () => {
    expect(verifySrc).toMatch(/trusted \? trusted\.spki : payload\.publicKey/);
    // The old unconditional use of the document's key must not come back.
    expect(verifySrc).not.toMatch(/verifyReportSignature\(\s*canonicalize\(attestation\),\s*payload\.signature,\s*payload\.publicKey\s*\)/);
  });

  it('the optional pin is gone — trust is not a parameter a caller can forget', () => {
    // Comments stripped first: the module explains at length WHY the old parameter was
    // removed, and a guard that matched its own prose would fail on documentation rather
    // than on behaviour.
    const code = verifySrc.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/expectedPublicKey/);
  });

  it('no production call site passes a trust-set override', () => {
    // The override exists for tests and for embedding another deployment's roots. If app
    // code started passing it, the default would stop being the thing that protects us.
    for (const f of [
      'apps/pwa/src/lib/report/verify.ts',
      'workers/api/src/lib/verification-page.ts',
      'workers/api/src/index.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} must not widen the trust set`).not.toMatch(/trustedSigners\s*:/);
    }
  });
});

describe('§D the four signer outcomes, and their ordering', () => {
  const known = TRUSTED_SIGNERS[0]!;

  it('an unknown key is SIGNER_UNKNOWN — the condition that used to pass as certified', () => {
    const v = evaluateSigner({ fingerprint: 'sha256:' + 'f'.repeat(64), signatureValid: true, signedAt: Date.now() });
    expect(v.outcome).toBe('SIGNER_UNKNOWN');
    expect(v.statement).toContain('does not publish');
  });

  it('a bad signature is SIGNATURE_INVALID even when the key IS ours', () => {
    // Decided before anything can excuse it: a signature that does not verify is not made
    // better by the key being one of ours.
    const v = evaluateSigner({ fingerprint: known.fingerprint, signatureValid: false, signedAt: Date.now(), role: known.role });
    expect(v.outcome).toBe('SIGNATURE_INVALID');
  });

  it('§C ROTATION: a signature predating retirement still verifies', () => {
    const retired: TrustedSigner = { ...known, validUntil: 2_000, fingerprint: 'sha256:rot' };
    const v = evaluateSigner({
      fingerprint: 'sha256:rot', signatureValid: true, signedAt: 1_000, role: known.role, trustedSigners: [retired],
    });
    // A survivor's export from a year ago must not stop verifying because a key rotated.
    expect(v.outcome).toBe('SIGNER_TRUSTED');
    expect(v.statement).toContain('has since been retired');
  });

  it('§C REVOCATION: after the instant fails, before it stands with a notice', () => {
    const revoked: TrustedSigner = {
      ...known, revokedAt: 5_000, revokedReason: 'key material exposed', fingerprint: 'sha256:rev',
    };
    const after = evaluateSigner({
      fingerprint: 'sha256:rev', signatureValid: true, signedAt: 9_000, role: known.role, trustedSigners: [revoked],
    });
    expect(after.outcome).toBe('SIGNER_REVOKED');
    expect(after.statement).toContain('key material exposed');

    const before = evaluateSigner({
      fingerprint: 'sha256:rev', signatureValid: true, signedAt: 1_000, role: known.role, trustedSigners: [revoked],
    });
    // A key being compromised today does not make last year's export a forgery.
    expect(before.outcome).toBe('SIGNER_TRUSTED');
    expect(before.statement).toContain('predates the revocation');
  });

  it('role separation: a report key cannot vouch for a custody manifest', () => {
    const reportKey = TRUSTED_SIGNERS.find((k) => k.role === 'report')!;
    const v = evaluateSigner({ fingerprint: reportKey.fingerprint, signatureValid: true, signedAt: 0, role: 'integrity' });
    expect(v.outcome).toBe('SIGNER_UNKNOWN');
  });
});

describe('§A/§E the trust set itself', () => {
  it('every fingerprint actually matches its own key bytes', async () => {
    // A typo'd fingerprint would silently untrust a real key, or worse, trust nothing while
    // appearing populated.
    for (const k of TRUSTED_SIGNERS) {
      expect(await fingerprintSpki(k.spki), k.label).toBe(k.fingerprint);
    }
  });

  it('is version-stamped, and the version is exported for the run banner', () => {
    expect(TRUST_SET_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(TRUSTED_SIGNERS.length).toBeGreaterThanOrEqual(2);
  });

  it('holds no private key material', () => {
    const src = readFileSync(join(ROOT, 'packages/shared/src/trust-roots.ts'), 'utf8');
    expect(src).not.toMatch(/PRIVATE KEY|pkcs8|privateKey/i);
  });

  it('is not fetched at runtime — no endpoint can widen it', () => {
    const src = readFileSync(join(ROOT, 'packages/shared/src/trust-roots.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it('a malformed key in a package cannot crash the verifier', async () => {
    // Runs on bytes the document supplies, which may be hostile. A verifier that throws is
    // a verifier that can be denied.
    expect(await fingerprintSpki('not-a-key')).toBe('sha256:unparseable');
    expect(await fingerprintSpki('')).toBeTruthy();
  });
});
