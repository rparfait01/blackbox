import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { envelopeEncryptionEnabled } from '@/lib/env';

/**
 * Brief 26 — fail-open guard for the capture path. The envelope is now WIRED into the
 * upload send path (step 3), so the invariant is no longer "not imported" but
 * "encryption can never break or block a capture." These pin that structurally:
 *   - the flag is ARMED (and arming still cannot break a capture);
 *   - the media recorder is still untouched (encryption lives in the upload layer);
 *   - the send path goes through sealChunkForSend (plaintext-by-default) and never calls
 *     the raw encrypt primitive directly;
 *   - encryptor setup is fire-and-forget, never awaited on the open/send path.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const uploadMgr = read('./lib/upload/upload-manager.ts');
const sealer = read('./lib/upload/capture-encryptor.ts');

describe('the envelope flag is ARMED', () => {
  it('is on by default, so no build can silently ship unencrypted captures', () => {
    // Armed 2026-07-30. The default lives in tracked code precisely so a fresh clone or CI
    // build cannot quietly disarm custody; `VITE_ENVELOPE_ENC=false` is the explicit way out.
    expect(envelopeEncryptionEnabled).toBe(true);
  });

  it('is still a real switch — the opt-out is a single explicit value', () => {
    const env = read('./lib/env.ts');
    expect(env).toMatch(/const ENVELOPE_DEFAULT = 'true';/);
    expect(env).toMatch(/!== 'false'/);
  });
});

describe('the media recorder is untouched — encryption is in the upload layer only', () => {
  it('media-capture does not import the crypto core', () => {
    expect(read('./lib/capture/media-capture.ts')).not.toMatch(/crypto\/envelope|encryptChunk/);
  });
});

describe('the send path is fail-open by construction', () => {
  it('chunk sending goes through sealChunkForSend, not a raw encryptChunk call', () => {
    expect(uploadMgr).toMatch(/sealChunkForSend\(/);
    // The send path must not call the raw AEAD directly — only via the fail-open wrapper.
    const sendItem = uploadMgr.slice(uploadMgr.indexOf('async function sendItem'), uploadMgr.indexOf('async function drainQueue'));
    expect(sendItem).not.toMatch(/\bencryptChunk\(/);
  });

  it('the body defaults to plaintext and is only replaced on a successful seal', () => {
    // sealChunkForSend returns { body } starting from the plaintext; sendItem assigns it.
    expect(uploadMgr).toMatch(/body = sealed\.body/);
    expect(sealer).toMatch(/const plaintextResult: SealResult = \{ body: opts\.plaintext/);
  });

  it('encryptor setup is fire-and-forget — never awaited on the open path', () => {
    expect(uploadMgr).toMatch(/void prepareEncryptor\(ctx\)/);
    // prepareEncryptor must not be awaited (that could delay the alert / block capture).
    expect(uploadMgr).not.toMatch(/await prepareEncryptor\(/);
  });

  it('the seal is time-bounded so a hung crypto call cannot wedge the send', () => {
    expect(sealer).toMatch(/withTimeout\(/);
    expect(sealer).toMatch(/ENCRYPT_TIMEOUT_MS/);
  });
});
