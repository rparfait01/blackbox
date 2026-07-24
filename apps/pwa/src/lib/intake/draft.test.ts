import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { saveDraft } from './draft';

/**
 * Brief 27 §3 — a partial intake draft gets the SAME fail-closed protection as a filed
 * record. It is sealed or it is not persisted; there is never a plaintext draft. (Resumable
 * sealed drafts prove out once the flag is armed — the round-trip primitive is proven in
 * case-file.test.ts; here we pin that nothing partial lands unencrypted while off.)
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('drafts are fail-closed (flag off in the test env)', () => {
  it('saveDraft is a no-op (persists nothing) when secure storage is unavailable', async () => {
    const saved = await saveDraft({ step: 'narrative', narrative: 'a half-finished disclosure' });
    expect(saved).toBe(false); // nothing sealed, nothing stored — never a plaintext draft
  });

  it('the draft module only ever stores a SEALED blob — no plaintext write path', () => {
    const src = read('./draft.ts');
    // It seals before storing, and the flag/key gates return BEFORE any store call.
    expect(src).toMatch(/sealToPublicKey/);
    expect(src).toMatch(/if \(!envelopeEncryptionEnabled\)[\s\S]*?return false/);
    // setStoredIntakeDraft only ever receives the JSON of a sealed envelope.
    expect(src).toMatch(/setStoredIntakeDraft\(JSON\.stringify\(sealed\)\)/);
    // No path stores the raw draft object.
    expect(src).not.toMatch(/setStoredIntakeDraft\(JSON\.stringify\(draft/);
  });
});
