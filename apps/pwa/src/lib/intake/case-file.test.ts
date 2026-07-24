import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildCaseFileRecord, openCaseFile, sealCaseFile } from './case-file';
import { generateAccountKeypair } from '@/lib/crypto/key-custody';

/**
 * Brief 27 §2 — FAIL-CLOSED is the paramount property. A case file is a survivor's
 * structured disclosure: it is sealed to their own key or it is NOT persisted. There is no
 * plaintext path — not while the flag is off, not without a key, not as a fallback.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const sampleRecord = buildCaseFileRecord({
  incidentTypeId: 'threats_intimidation',
  whenRange: 'past_month',
  location: { granularity: 'region', regionId: 'jp' },
  relationshipId: 'former_partner',
  weaponCoercionFlags: ['threats_used'],
  injuryId: 'none_apparent',
  reportedToAuthorities: 'no',
  priorIncidents: 'yes',
  narrative: 'A sensitive disclosure that must never be stored in plaintext.',
  classificationDraft: null,
  submissionMonth: '2026-07',
});

describe('fail-closed: no plaintext path exists (flag off in the test env)', () => {
  it('sealCaseFile refuses and returns NO bytes when the flag is off', async () => {
    // VITE_ENVELOPE_ENC is unset in the test/build env → envelopeEncryptionEnabled is false.
    const res = await sealCaseFile(sampleRecord);
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty('sealed'); // it can NEVER hand back a plaintext-or-any blob
    if (!res.ok) expect(res.reason).toBe('secure_storage_unavailable');
  });

  it('the module has no branch that returns plaintext bytes for storage', () => {
    const src = read('./case-file.ts');
    // The only thing sent to storage is a SEALED envelope; assert the seal is required.
    expect(src).toMatch(/sealToPublicKey/);
    // There is no "if disabled → send plaintext" fallback: the refusal returns before any seal.
    expect(src).toMatch(/if \(!envelopeEncryptionEnabled\)[\s\S]*?return \{ ok: false/);
    expect(src).not.toMatch(/JSON\.stringify\(record\)[\s\S]{0,80}(upload|POST|body:)/i);
  });

  it('the taxonomy mapping is stamped so a filed record is standardized', () => {
    expect(sampleRecord.taxonomyVersion).toMatch(/nibrs/);
    expect(sampleRecord.mapping.nibrs).toContain('13C'); // threats → Intimidation
  });
});

describe('round-trip when encryption IS available (simulated with a real keypair)', () => {
  it('a case file sealed to a key opens only with that key', async () => {
    // sealCaseFile is flag-gated, so drive the seal primitive directly with a real key to
    // prove the ZK round-trip the survivor gets once armed.
    const { sealToPublicKey, importPublicKey } = await import('@/lib/crypto/envelope');
    const kp = await generateAccountKeypair();
    const bytes = new TextEncoder().encode(JSON.stringify(sampleRecord));
    const sealed = JSON.stringify(await sealToPublicKey(bytes, await importPublicKey(kp.publicKey)));

    const opened = await openCaseFile(sealed, kp.privateKey);
    expect(opened.narrative).toBe(sampleRecord.narrative);
    expect(opened.mapping.nibrs).toContain('13C');

    // A different key cannot open it — the server (no key) certainly cannot.
    const intruder = await generateAccountKeypair();
    await expect(openCaseFile(sealed, intruder.privateKey)).rejects.toBeTruthy();
  });
});
