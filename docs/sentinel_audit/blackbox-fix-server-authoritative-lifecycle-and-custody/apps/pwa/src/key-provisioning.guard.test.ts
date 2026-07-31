import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { provisionSurvivorKey } from '@/lib/crypto/key-provisioning';

/**
 * Brief 26 — keygen must obey the same fail-open rule as the send path: provisioning
 * NEVER blocks reaching Armed and NEVER breaks a trigger. If keygen fails or hangs, the
 * survivor is still Armed, still triggers, just without encryption.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('provisioning is fire-and-forget and never throws', () => {
  it('returns void synchronously and does not throw when the flag is off (no-op)', () => {
    // In the test/build env VITE_ENVELOPE_ENC is unset → the function is a no-op and must
    // return immediately without a promise the caller could accidentally await/await-throw.
    expect(provisionSurvivorKey()).toBeUndefined();
    expect(provisionSurvivorKey('AB12-CD34-EF56')).toBeUndefined();
  });
});

describe('onboarding wires it non-blockingly', () => {
  const onboarding = read('./routes/onboarding/Onboarding.tsx');
  it('is called fire-and-forget (never awaited on the path to Armed)', () => {
    expect(onboarding).toMatch(/provisionSurvivorKey\(\)/); // at finalize
    expect(onboarding).toMatch(/provisionSurvivorKey\(res\.data\.codes\[0\]\)/); // at recovery code
    expect(onboarding).not.toMatch(/await provisionSurvivorKey\(/);
  });
});

describe('provisioning is bounded and flag-gated', () => {
  const prov = read('./lib/crypto/key-provisioning.ts');
  it('no-ops unless the flag is armed', () => {
    expect(prov).toMatch(/if \(!envelopeEncryptionEnabled\)/);
  });
  it('is time-bounded (a hang is abandoned, not awaited)', () => {
    expect(prov).toMatch(/withTimeout\(runProvision/);
    expect(prov).toMatch(/PROVISION_TIMEOUT_MS/);
  });
  it('device-custodies the private key BEFORE any upload', () => {
    const run = prov.slice(prov.indexOf('async function runProvision'));
    expect(run.indexOf('setStoredEnvelopeKeypair')).toBeLessThan(run.indexOf("api('/v1/me/pubkey'"));
  });
});
