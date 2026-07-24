import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { envelopeEncryptionEnabled } from '@/lib/env';

/**
 * Brief 26 Phase 1 — dormancy guard. Until the flag is armed, the zero-knowledge
 * envelope must change NOTHING on the capture path. This pins that: the flag defaults
 * OFF, and the capture/upload pipeline does not yet import the crypto core — so a
 * regression that quietly wires encryption into the send path (before the fail-open
 * step 3 is built) trips here instead of risking a survivor's recording.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('the envelope flag defaults OFF', () => {
  it('is false unless VITE_ENVELOPE_ENC is exactly "true"', () => {
    expect(envelopeEncryptionEnabled).toBe(false);
  });
});

describe('the capture path is untouched while dormant', () => {
  it('the upload manager does not import the envelope crypto (no encrypt on the send path yet)', () => {
    const upload = read('./lib/upload/upload-manager.ts');
    expect(upload).not.toMatch(/crypto\/envelope|encryptChunk|wrapDek/);
  });
  it('media capture does not import the envelope crypto', () => {
    const capture = read('./lib/capture/media-capture.ts');
    expect(capture).not.toMatch(/crypto\/envelope|encryptChunk/);
  });
});

describe('the crypto core stays server-blind by construction', () => {
  it('the envelope core never exports a way to hand a private key to the server', () => {
    // A sanity tripwire: the only exports that touch a private key operate client-side
    // (unwrap/open); nothing serializes a private key for upload in the core.
    const core = read('./lib/crypto/envelope.ts');
    expect(core).not.toMatch(/upload|fetch\(|POST/i);
  });
});
